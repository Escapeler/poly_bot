/**
 * index.js — Polymarket Copy Trade Bot (via Almanac)
 *
 * Auth flow:
 *   1. Generate Polymarket API creds (apiKey/secret/passphrase) via deriveKeys.js
 *   2. Bot creates Almanac session, passing those creds
 *   3. Orders go through Almanac (EIP-712 signed)
 *
 * Usage:
 *   npm start              — Run the bot
 *   DRY_RUN=true npm start — Simulate without orders
 *   npm run status         — Print config and exit
 *
 * Bug Fixes (vs Python version):
 *   1. INSUFFICIENT_BALANCE — pre-check balance before every order
 *   2. INVALID_FEE_RATE    — auto-learn fee from error + cache per market
 *   3. 502 BAD GATEWAY     — exponential backoff retry (p-retry)
 *   4. DOUBLE ORDERS       — txHash+logIndex dedup Set + 3s debounce
 *   5. MAX POSITION LIMIT  — enforce per-market + global position caps
 */

import config from './config.js';
import { logger, logEvent } from './utils.js';
import walletManager from './wallet.js';
import APIClient from './apiClient.js';
import TradeListener from './tradeListener.js';
import CopyTradeEngine from './copytrade.js';
import AutoRedeemEngine from './redeem.js';
import HealthCheckServer from './healthcheck.js';
import { deriveApiCredentials, saveCredsToEnv } from './deriveKeys.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

// ═══════════════════════════════════════════════════════════
// STATUS MODE
// ═══════════════════════════════════════════════════════════

if (process.argv.includes('--status')) {
  console.log('\n=== POLYMARKET BOT CONFIG ===\n');
  console.log(`  Wallet:         ${config.walletAddress}`);
  console.log(`  Funder:         ${config.funderAddress}`);
  console.log(`  Sig type:       ${config.signatureType}`);
  console.log(`  API key:        ${config.polyApiKey ? config.polyApiKey.slice(0, 8) + '...' : '(will auto-derive on start)'}`);
  console.log(`  Targets:        ${config.targetWallets.join(', ') || '(none configured)'}`);
  console.log(`  Almanac URL:    ${config.almanacBaseUrl}`);
  console.log(`  CLOB URL:       ${config.polymarketClobUrl}`);
  console.log(`  Multiplier:     ${config.sizeMultiplier}x`);
  console.log(`  Max position:   $${config.maxPositionUsdc}`);
  console.log(`  Order type:     ${config.defaultOrderType}`);
  console.log(`  Auto redeem:    ${config.autoRedeemEnabled}`);
  console.log(`  Kill switch:    ${config.killSwitchEnabled}`);
  console.log(`  RPC primary:    ${config.resolvedRpcUrl}`);
  console.log(`  RPC WS:         ${config.resolvedWsUrl}`);
  console.log(`  Infura:         ${config.infuraApiKey ? 'YES' : 'NOT CONFIGURED'}`);
  console.log(`  Fallbacks:      ${config.rpcFallbackUrls.length}`);
  for (const [i, fb] of config.rpcFallbackUrls.entries()) {
    console.log(`    ${i + 1}. ${fb}`);
  }
  console.log('\n  Auth flow:');
  console.log('  Private key → auto-derive API creds (EIP-712)');
  console.log('  → passed to Almanac /v1/trading/sessions');
  console.log('  → Almanac stores encrypted, trades on your behalf');
  console.log('  → NO separate Almanac API keys needed');
  console.log('  → NO Python needed\n');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════
// MAIN BOT
// ═══════════════════════════════════════════════════════════

class PolymarketBot {
  constructor() {
    this._running = false;
    this._api = new APIClient();
    this._copytrade = new CopyTradeEngine(this._api);
    this._listener = null;
    this._redeem = null;
    this._health = null;
    this._intervals = [];
  }

  async start() {
    this._running = true;

    logger.info('='.repeat(60));
    logger.info('  POLYMARKET COPY TRADE BOT (Node.js / via Almanac)');
    logger.info('='.repeat(60));
    logger.info(`  Wallet:      ${config.walletAddress.slice(0, 10)}...${config.walletAddress.slice(-6)}`);
    logger.info(`  Funder:      ${config.funderAddress.slice(0, 10)}...${config.funderAddress.slice(-6)}`);
    logger.info(`  Sig type:    ${config.signatureType}`);
    logger.info(`  Targets:     ${config.targetWallets.length} wallet(s)`);
    logger.info(`  Multiplier:  ${config.sizeMultiplier}x`);
    logger.info(`  Max pos:     $${config.maxPositionUsdc}`);
    logger.info(`  Slippage:    ${config.slippageTolerance * 100}%`);
    logger.info(`  Order type:  ${config.defaultOrderType}`);
    logger.info(`  Auto redeem: ${config.autoRedeemEnabled}`);
    logger.info(`  Kill switch: ${config.killSwitchEnabled}`);
    logger.info(`  Dry run:     ${DRY_RUN}`);
    logger.info(`  Almanac URL: ${config.almanacBaseUrl}`);
    logger.info(`  RPC primary: ${config.resolvedRpcUrl.slice(0, 50)}...`);
    logger.info(`  Infura:      ${config.infuraApiKey ? 'YES' : 'NO (using public RPCs)'}`);
    logger.info('='.repeat(60));

    if (config.targetWallets.length === 0) {
      logger.error('No target wallets configured! Set TARGET_WALLETS in .env');
      return;
    }

    // Step 0a: Auto-derive API credentials if not set
    if (!config.polyApiKey || !config.polyApiSecret || !config.polyApiPassphrase) {
      logger.info('API credentials not found in .env — auto-deriving from private key...');
      try {
        const creds = await deriveApiCredentials(config.walletPrivateKey, config.polymarketClobUrl);
        // Update runtime config
        config.polyApiKey = creds.apiKey;
        config.polyApiSecret = creds.secret;
        config.polyApiPassphrase = creds.passphrase;
        // Save to .env so next startup is instant
        saveCredsToEnv(creds);
        logger.info(`API credentials derived and saved to .env`);
        logger.info(`  API Key: ${creds.apiKey.slice(0, 12)}...`);
      } catch (err) {
        logger.error(`Auto-derive FAILED: ${err.message}`);
        logger.error('Set POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE in .env manually.');
        return;
      }
    } else {
      logger.info(`API credentials loaded from .env (key: ${config.polyApiKey.slice(0, 12)}...)`);
    }

    // Step 0b: Initialize wallet + verify RPC
    walletManager.init();
    try {
      const block = await walletManager.getBlockNumber();
      logger.info(`RPC connected — block #${block}`);
      try {
        const matic = await walletManager.getMaticBalance();
        const usdc = await walletManager.getUsdcBalance();
        logger.info(`Funder balance: ${matic.toFixed(4)} MATIC, ${usdc.toFixed(2)} USDC`);
        if (usdc < 1.0) logger.warn('USDC balance very low — deposit funds before trading');
        if (matic < 0.01) logger.info('MATIC balance is 0 — only needed for on-chain redeem, NOT for CLOB trading');
      } catch (err) {
        logger.warn(`Balance check failed: ${err.message}`);
      }
    } catch (err) {
      logger.warn(`RPC check failed: ${err.message} — on-chain operations may be unavailable`);
    }

    // Step 1: HTTP client
    await this._api.start();

    // Step 2: Almanac session
    try {
      const session = await this._api.createAlmanacSession();
      logger.info(`Almanac session active: ${session.sessionId.slice(0, 20)}...`);
      logger.info(`Proxy wallet: ${session.proxyWallet}`);
    } catch (err) {
      logger.error(`Almanac session FAILED: ${err.message}`);
      logger.error('Cannot trade without Almanac session. Check credentials and try again.');
      return;
    }

    // Step 2b: Load Almanac market index
    try {
      const count = await this._api.loadAlmanacMarkets();
      logger.info(`Almanac market index loaded: ${count} markets, ${this._api.almanacIndexSize} tokens`);
    } catch (err) {
      logger.warn(`Failed to load Almanac markets: ${err.message}`);
      logger.warn('Bot will try to refresh index when first order comes in');
    }

    // Step 3: Trade listener (WS + REST)
    this._listener = new TradeListener(this._api, config.targetWallets);
    this._listener.onNewTrade(async (event) => {
      if (!DRY_RUN) {
        await this._copytrade.handleTradeSignal(event);
      } else {
        const side = (event.side || 'BUY').toUpperCase();
        const price = parseFloat(event.price || 0);
        const size = parseFloat(event.size || 0);
        logger.info(`[DRY-RUN] Would copy: ${side} ${size.toFixed(2)}@${price.toFixed(4)}`);
      }
    });
    await this._listener.start();

    // Step 4: Auto-redeem
    this._redeem = new AutoRedeemEngine(this._api, this._copytrade);
    this._copytrade.setRedeemEngine(this._redeem);
    await this._redeem.start();

    // Step 5: Healthcheck server
    this._health = new HealthCheckServer(this._copytrade, () => true /* simplified */, this._api);
    await this._health.start();

    // Step 6: Background tasks
    // Metrics reporter (every 60s)
    this._intervals.push(setInterval(() => {
      if (!this._running) return;
      const m = this._copytrade.metrics;
      const pos = Object.keys(this._copytrade.openPositions).length;
      logger.info(
        `📊 trades=${m.totalTradesCopied} filled=${m.totalOrdersFilled} ` +
        `failed=${m.totalOrdersFailed} | ` +
        `PnL=$${m.realizedPnl.toFixed(2)} vol=$${m.totalVolumeUsdc.toFixed(2)} | ` +
        `pos=${pos} lat=${m.avgLatencyMs.toFixed(0)}ms`,
      );
    }, 60000));

    // Daily reset (midnight UTC)
    this._scheduleDailyReset();

    // Session refresh (every 30min)
    this._intervals.push(setInterval(async () => {
      if (!this._running) return;
      try {
        await this._api.createAlmanacSession();
        logger.info('Almanac session refreshed');
      } catch (err) {
        logger.warn(`Session refresh failed: ${err.message}`);
      }
    }, 1800000));

    // 5-min market index refresh (every 2 minutes)
    // Critical for BTC/ETH/SOL 5-min markets — new markets appear every 5 mins
    this._intervals.push(setInterval(async () => {
      if (!this._running) return;
      try {
        await this._api._load5minMarkets();
      } catch { /* non-critical */ }
    }, 120000));

    logEvent('bot_started', { dry_run: DRY_RUN });
    logger.info('Bot is running. Press Ctrl+C to stop.');
  }

  _scheduleDailyReset() {
    const now = Date.now();
    const midnight = Math.ceil(now / 86400000) * 86400000; // next UTC midnight
    const msUntil = midnight - now;

    const timer = setTimeout(() => {
      this._copytrade.resetDailyMetrics();
      logger.info('Daily metrics reset (UTC midnight)');
      this._scheduleDailyReset(); // schedule next
    }, msUntil);

    this._intervals.push(timer);
  }

  async stop() {
    logger.info('Shutting down...');
    this._running = false;

    for (const id of this._intervals) {
      clearInterval(id);
      clearTimeout(id);
    }

    if (this._listener) await this._listener.stop();
    if (this._redeem) await this._redeem.stop();
    if (this._health) await this._health.stop();
    await this._api.stop();

    const m = this._copytrade.metrics;
    const uptime = Date.now() / 1000 - m.startedAt;

    logger.info('='.repeat(60));
    logger.info('  FINAL REPORT');
    logger.info(`  Uptime:         ${(uptime / 3600).toFixed(1)} hours`);
    logger.info(`  Trades copied:  ${m.totalTradesCopied}`);
    logger.info(`  Orders filled:  ${m.totalOrdersFilled}`);
    logger.info(`  Realized PnL:   $${m.realizedPnl.toFixed(2)}`);
    logger.info(`  Win rate:       ${(this._copytrade.winRate * 100).toFixed(1)}%`);
    logger.info(`  Avg latency:    ${m.avgLatencyMs.toFixed(1)}ms`);
    logger.info(`  Total volume:   $${m.totalVolumeUsdc.toFixed(2)}`);
    logger.info('='.repeat(60));

    logEvent('bot_stopped', { uptime_hours: Math.round(uptime / 3600 * 100) / 100 });
  }
}

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════

const bot = new PolymarketBot();
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  await bot.stop();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// Start
bot.start().catch(err => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
