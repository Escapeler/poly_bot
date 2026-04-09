/**
 * redeem.js — Auto-Redeem Engine.
 *
 * Batches redeemable positions (winning) into a single Safe transaction.
 * Lost positions are marked as done (no on-chain redeem needed).
 */

import config from './config.js';
import walletManager from './wallet.js';
import { logger, logEvent } from './utils.js';

class AutoRedeemEngine {
  /**
   * @param {import('./apiClient.js').default} api
   * @param {import('./copytrade.js').default} copytrade
   */
  constructor(api, copytrade) {
    this._api = api;
    this._copytrade = copytrade;
    this._running = false;
    this._redeemed = new Set();
    this._failed = {};           // conditionId → failTimestamp
    this._RETRY_AFTER_SEC = 180; // 3 minutes
    this._timer = null;
  }

  async start() {
    if (!config.autoRedeemEnabled) {
      logger.info('Auto-redeem disabled');
      return;
    }
    this._running = true;
    this._loop();
    logger.info(`Auto-redeem started (interval=${config.redeemCheckIntervalSec}s)`);
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
  }

  triggerEmergencyRedeem() {
    logger.info('🚨 Emergency redeem triggered');
    this._failed = {};
    this._checkAndRedeem(true);
  }

  async _loop() {
    while (this._running) {
      try {
        await this._checkAndRedeem();
      } catch (err) {
        logger.warn(`Redeem loop error: ${err.message}`);
      }
      await sleep(config.redeemCheckIntervalSec * 1000);
    }
  }

  async _checkAndRedeem(emergency = false) {
    if (!config.funderAddress) return;

    let positions;
    try {
      positions = await this._api.getRedeemablePositions();
    } catch { return; }

    const now = Date.now() / 1000;
    if (emergency) this._failed = {};

    const toRedeem = [];

    for (const pos of positions) {
      const conditionId = pos.conditionId || '';
      if (!conditionId || this._redeemed.has(conditionId)) continue;
      if (!pos.redeemable) continue;

      if (this._failed[conditionId]) {
        if (now - this._failed[conditionId] < this._RETRY_AFTER_SEC) continue;
        delete this._failed[conditionId];
      }

      const size = parseFloat(pos.size || 0);
      if (size <= 0) continue;

      const curPrice = parseFloat(pos.curPrice !== undefined ? pos.curPrice : -1);
      if (curPrice !== 0.0 && curPrice !== 1.0) continue;

      toRedeem.push(pos);
    }

    if (toRedeem.length === 0) return;

    const winning = toRedeem.filter(p => parseFloat(p.curPrice || 0) === 1.0);
    const lost = toRedeem.filter(p => parseFloat(p.curPrice || 0) === 0.0);
    const totalWin = winning.reduce((sum, p) => sum + parseFloat(p.size || 0), 0);

    // Batch redeem winning positions
    if (winning.length > 0) {
      logger.info(`💰 Batch redeem ${winning.length} wins ($${totalWin.toFixed(2)})...`);

      const result = await walletManager.executeSafeBatchRedeem(
        winning.map(p => ({
          conditionId: p.conditionId,
          outcomeIndex: parseInt(p.outcomeIndex || 0),
        })),
      );

      if (result.success) {
        for (const pos of winning) {
          this._redeemed.add(pos.conditionId);
        }
        this._copytrade.metrics.totalRedeems += winning.length;
        this._copytrade.metrics.realizedPnl += totalWin;
        logger.info(`✅ ${winning.length} wins redeemed ($${totalWin.toFixed(2)}) | tx=${result.txHash}`);
      } else {
        for (const pos of winning) {
          this._failed[pos.conditionId] = now;
        }
        logger.warn(`❌ Batch failed: ${result.error} (retry in 3min)`);

        // Fallback: try individually
        logger.info('🔄 Fallback: redeeming wins individually...');
        for (const pos of winning) {
          if (this._redeemed.has(pos.conditionId)) continue;
          await this._singleRedeem(pos, now);
        }
      }
    }

    // Lost positions: just mark as done
    if (lost.length > 0) {
      for (const pos of lost) {
        this._redeemed.add(pos.conditionId);
      }
      logger.info(`🗑️ Skipped ${lost.length} lost positions`);
    }
  }

  async _singleRedeem(pos, now) {
    const conditionId = pos.conditionId || '';
    const size = parseFloat(pos.size || 0);
    const indexSet = 1 << (parseInt(pos.outcomeIndex || 0));

    const result = await walletManager.executeSafeSingleRedeem(conditionId, indexSet);

    if (result.success) {
      this._redeemed.add(conditionId);
      this._copytrade.metrics.totalRedeems++;
      this._copytrade.metrics.realizedPnl += size;
      logger.info(`✅ Single redeemed $${size.toFixed(2)} | tx=${result.txHash}`);
    } else {
      this._failed[conditionId] = now;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default AutoRedeemEngine;
