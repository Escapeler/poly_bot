/**
 * copytrade.js — Copy Trade Engine.
 *
 * Flow:
 *   1. Signal from target wallet (via tradeListener)
 *   2. Validate: kill switch, size, price, balance, position limits
 *   3. Place order via Almanac
 *   4. Track position
 *
 * BUG FIXES:
 *   1. INSUFFICIENT_BALANCE — pre-checked in apiClient
 *   5. MAX POSITION LIMIT — enforced before every order
 */

import config from './config.js';
import { logger, logEvent, logCopyTrade } from './utils.js';

class CopyTradeEngine {
  /**
   * @param {import('./apiClient.js').default} api
   */
  constructor(api) {
    this._api = api;

    // ── Metrics ────────────────────────────────────────
    this.metrics = {
      totalTradesCopied: 0,
      totalOrdersPlaced: 0,
      totalOrdersFilled: 0,
      totalOrdersFailed: 0,
      totalRedeems: 0,
      realizedPnl: 0,
      totalVolumeUsdc: 0,
      avgLatencyMs: 0,
      latencySamples: [],
      dailyLoss: 0,
      winCount: 0,
      lossCount: 0,
      startedAt: Date.now() / 1000,
    };

    // ── Positions ──────────────────────────────────────
    this._positions = {};         // posKey → { marketId, tokenId, side, entryPrice, size, sourceWallet }

    // ── Safety ─────────────────────────────────────────
    this._killSwitchActive = false;
    this._balancePauseUntil = 0;
    this._rejectedMarkets = new Set();

    // Cooldown is now PER SIDE PER MARKET:
    //   BUY cooldown: configurable (default 2s)
    //   SELL cooldown: 0s (NEVER block exits)
    this._buyCooldown = {};      // posKey → lastBuyTimestamp

    // Track in-flight orders to avoid over-committing balance
    this._inFlightUsdc = 0;

    this._redeemEngine = null;
  }

  setRedeemEngine(redeem) {
    this._redeemEngine = redeem;
  }

  // ═══════════════════════════════════════════════════════
  // HANDLE TRADE SIGNAL
  // ═══════════════════════════════════════════════════════

  async handleTradeSignal(rawEvent) {
    if (this._killSwitchActive) return;
    if (Date.now() / 1000 < this._balancePauseUntil) return;

    const signal = this._parseSignal(rawEvent);
    if (!signal) return;

    // Skip stale signals
    if (signal.timestamp > 0) {
      const ageSec = (Date.now() / 1000) - signal.timestamp;
      if (ageSec > config.maxSignalAgeSec) return;
    }

    // Skip token=0
    if (!signal.tokenId || signal.tokenId === '0') return;

    const cooldownKey = signal.marketId || signal.tokenId;

    // Skip SELL if we don't have this position
    if (signal.side === 'SELL') {
      const hasPos = (
        (signal.marketId && this._positions[signal.marketId]) ||
        (signal.tokenId && this._positions[signal.tokenId])
      );
      if (!hasPos) return;
    }

    // Skip rejected markets
    if (this._rejectedMarkets.has(cooldownKey)) return;

    // ── COOLDOWN: per-side, per-market ──────────────────
    const now = Date.now() / 1000;

    if (signal.side === 'BUY') {
      // BUY cooldown: configurable, default 2s
      const lastBuy = this._buyCooldown[cooldownKey] || 0;
      if (now - lastBuy < config.buyCooldownSec) return;
      this._buyCooldown[cooldownKey] = now;
    }
    // SELL: NO COOLDOWN — exits must never be blocked

    // Kill switch checks
    if (config.killSwitchEnabled) {
      if (this.metrics.dailyLoss >= config.maxDailyLossUsdc) {
        this._killSwitchActive = true;
        logger.warn('🛑 Kill switch activated — daily loss limit reached');
        return;
      }

      // FIX 5: MAX POSITION LIMIT
      if (Object.keys(this._positions).length >= config.maxOpenPositions) {
        logger.info(`[SKIP] max open positions reached (${config.maxOpenPositions})`);
        return;
      }
    }

    // Price validation
    if (signal.price <= 0 || signal.price >= 1.0) {
      logger.info(`⏭️ SKIP price=${signal.price.toFixed(4)} token=${signal.tokenId.slice(0, 16)}...`);
      return;
    }

    // Size calculation respects position limits
    let adjustedSize = this._calculateSize(signal);
    if (adjustedSize <= 0) {
      logger.info(`[SKIP] max position reached for ${cooldownKey.slice(0, 16)}...`);
      return;
    }

    // Pass signal price to apiClient — mid-price validation + slippage
    // adjustment happens there with real-time CLOB data.
    // We only do a basic sanity adjustment here as fallback.
    const adjustedPrice = this._adjustPrice(signal.price, signal.side);

    // Enforce Almanac $1 minimum notional
    let notional = adjustedSize * adjustedPrice;
    if (notional < 1.0 && adjustedPrice > 0) {
      const minSize = Math.round((1.0 / adjustedPrice + 0.5) * 100) / 100;
      if (minSize * adjustedPrice <= config.maxPositionUsdc) {
        adjustedSize = minSize;
      } else {
        return;
      }
    }

    const order = {
      tokenId: signal.tokenId,
      price: adjustedPrice,
      size: adjustedSize,
      side: signal.side,
      orderType: config.defaultOrderType,
      marketId: signal.marketId,
      negRisk: signal.negRisk || false,
      tickSize: signal.tickSize || '0.01',
    };

    logger.info(`[${signal.side}] market=${cooldownKey.slice(0, 20)} price=${adjustedPrice} size=$${(adjustedSize * adjustedPrice).toFixed(2)}`);

    // Track in-flight USDC commitment (prevents burst overspend)
    const orderCost = adjustedSize * adjustedPrice;
    if (signal.side === 'BUY') {
      this._inFlightUsdc += orderCost;
    }

    // Place order
    const result = await this._api.placeOrder(order);

    // Release in-flight commitment
    if (signal.side === 'BUY') {
      this._inFlightUsdc = Math.max(0, this._inFlightUsdc - orderCost);
    }

    if (result.success) {
      this._trackPosition(signal, adjustedSize, adjustedPrice);
      this.metrics.totalTradesCopied++;
      this.metrics.totalOrdersFilled++;
      this.metrics.totalVolumeUsdc += orderCost;

      // Force balance refresh after successful BUY (prevents stale cache overspend)
      if (signal.side === 'BUY') {
        this._api.getAvailableBalance(true); // fire-and-forget refresh
      }

      logCopyTrade(
        signal.sourceWallet, cooldownKey, signal.side,
        adjustedPrice, signal.size, adjustedSize, result.latencyMs || 0,
      );
    } else {
      const err = result.errorMsg || '';
      if (!err.includes('not in Almanac')) {
        this.metrics.totalOrdersFailed++;
        logger.warn(`❌ Order failed: ${err}`);

        if (err.includes('FAK ORDER') || err.includes('NO ORDERS FOUND')) {
          this.metrics.totalOrdersFailed--;
        }
      }
      if (err.includes('MARKET_NOT_FOUND')) {
        this._rejectedMarkets.add(cooldownKey);
      }
      if (err.includes('INSUFFICIENT_BALANCE')) {
        this._balancePauseUntil = Date.now() / 1000 + 60;
        logger.info('💰 Balance low — pausing 60s');
        if (this._redeemEngine) {
          this._redeemEngine.triggerEmergencyRedeem();
        }
      }
    }

    this._recordLatency(result.latencyMs || 0);
    this.metrics.totalOrdersPlaced++;
  }

  // ═══════════════════════════════════════════════════════
  // SIGNAL PARSING
  // ═══════════════════════════════════════════════════════

  _parseSignal(raw) {
    try {
      // WebSocket market channel format
      if (raw.event_type === 'last_trade_price') {
        return {
          sourceWallet: raw._source_wallet || 'unknown',
          marketId: raw.market || '',
          tokenId: raw.asset_id || '',
          side: (raw.side || 'BUY').toUpperCase(),
          price: parseFloat(raw.price || 0),
          size: parseFloat(raw.size || 0),
          timestamp: parseFloat(raw.timestamp || 0) / 1000,
          txHash: raw.transaction_hash,
        };
      }

      // Data API activity / on-chain format
      if (raw.conditionId || raw.market || raw.asset) {
        let side = (raw.side || raw.type || 'BUY').toUpperCase();
        if (side !== 'BUY' && side !== 'SELL') side = 'BUY';

        const tokenId = raw.asset || raw.assetId || raw.asset_id || raw.tokenId || '';

        return {
          sourceWallet: raw._source_wallet || raw.proxyWallet || 'unknown',
          marketId: raw.conditionId || raw.market || '',
          tokenId,
          side,
          price: parseFloat(raw.price || 0),
          size: parseFloat(raw.size || raw.usdcSize || 0),
          timestamp: parseFloat(raw.timestamp || 0),
          txHash: raw.transactionHash || raw.transaction_hash,
          outcome: raw.outcome,
          negRisk: raw.negRisk || false,
          tickSize: raw.tickSize || '0.01',
        };
      }

      logger.debug(`Unrecognized event format: ${Object.keys(raw).slice(0, 10).join(', ')}`);
      return null;
    } catch (err) {
      logger.error(`Failed to parse signal: ${err.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // SIZE / PRICE (FIX 5: MAX POSITION LIMIT)
  // ═══════════════════════════════════════════════════════

  _calculateSize(signal) {
    let baseSize = signal.size * config.sizeMultiplier;
    const cost = baseSize * signal.price;

    // Detect 5-min crypto market via fee rate cache in apiClient
    const almanacId = this._api.resolveAlmanacId(signal.tokenId);
    const is5min = almanacId && (this._api._marketFeeRates[almanacId] || 0) >= 1000;

    // Skip 5-min markets entirely if disabled
    if (is5min && !config.enable5minMarkets) {
      logger.info(`[SKIP] 5-min market disabled: ${signal.tokenId.slice(0, 16)}...`);
      return 0;
    }

    // Use separate position limit for 5-min markets (higher risk, lower size)
    const maxPos = is5min ? config.maxPosition5minUsdc : config.maxPositionUsdc;

    // Cap to max position
    if (cost > maxPos) {
      baseSize = maxPos / signal.price;
    }

    // FIX 5: Check existing position and enforce limit
    const posKey = signal.marketId || signal.tokenId;
    const existing = this._positions[posKey];
    if (existing) {
      const existingCost = existing.size * existing.entryPrice;
      const remaining = maxPos - existingCost;
      if (remaining <= 0) return 0;
      baseSize = Math.min(baseSize, remaining / signal.price);
    }

    // BURST PROTECTION: subtract in-flight USDC from available budget
    if (signal.side === 'BUY' && this._inFlightUsdc > 0) {
      const effectiveBudget = Math.max(0, maxPos - this._inFlightUsdc);
      if (effectiveBudget < 1.0) return 0;
      const maxFromBudget = effectiveBudget / signal.price;
      baseSize = Math.min(baseSize, maxFromBudget);
    }

    return Math.round(Math.max(baseSize, 0) * 100) / 100;
  }

  _adjustPrice(price, side) {
    if (side === 'BUY') {
      return Math.min(
        Math.round(price * (1 + config.slippageTolerance) * 10000) / 10000,
        0.99,
      );
    } else {
      return Math.max(
        Math.round(price * (1 - config.slippageTolerance) * 10000) / 10000,
        0.01,
      );
    }
  }

  // ═══════════════════════════════════════════════════════
  // POSITION TRACKING
  // ═══════════════════════════════════════════════════════

  _trackPosition(signal, size, price) {
    const posKey = signal.marketId || signal.tokenId;
    const existing = this._positions[posKey];

    if (signal.side === 'BUY') {
      if (existing && existing.side === 'BUY') {
        const totalSize = existing.size + size;
        const avgPrice = (existing.entryPrice * existing.size + price * size) / totalSize;
        existing.size = totalSize;
        existing.entryPrice = avgPrice;
      } else {
        this._positions[posKey] = {
          marketId: posKey,
          tokenId: signal.tokenId,
          side: signal.side,
          entryPrice: price,
          size,
          sourceWallet: signal.sourceWallet,
        };
      }
    } else if (signal.side === 'SELL' && existing) {
      existing.size -= size;
      if (existing.size <= 0) {
        const pnl = (price - existing.entryPrice) * size;
        this.metrics.realizedPnl += pnl;
        if (pnl >= 0) {
          this.metrics.winCount++;
        } else {
          this.metrics.lossCount++;
          this.metrics.dailyLoss += Math.abs(pnl);
        }
        delete this._positions[posKey];
        logEvent('position_closed', { marketId: posKey, pnl: Math.round(pnl * 10000) / 10000 });
      }
    }
  }

  _recordLatency(ms) {
    this.metrics.latencySamples.push(ms);
    if (this.metrics.latencySamples.length > 1000) {
      this.metrics.latencySamples = this.metrics.latencySamples.slice(-1000);
    }
    const sum = this.metrics.latencySamples.reduce((a, b) => a + b, 0);
    this.metrics.avgLatencyMs = sum / this.metrics.latencySamples.length;
  }

  // ═══════════════════════════════════════════════════════
  // ACCESSORS
  // ═══════════════════════════════════════════════════════

  get openPositions() { return { ...this._positions }; }
  get isKillSwitched() { return this._killSwitchActive; }

  get winRate() {
    const total = this.metrics.winCount + this.metrics.lossCount;
    return total > 0 ? this.metrics.winCount / total : 0;
  }

  resetDailyMetrics() {
    this.metrics.dailyLoss = 0;
    this._killSwitchActive = false;
    this._balancePauseUntil = 0;
    logger.info('Daily metrics reset');
  }
}

export default CopyTradeEngine;
