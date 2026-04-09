/**
 * config.js — Centralized configuration loader.
 * Reads all settings from .env file.
 *
 * KEY CONCEPT:
 *   Almanac does NOT have its own API credentials.
 *   You generate Polymarket API credentials (apiKey, secret, passphrase)
 *   from your wallet, then pass them to Almanac's /v1/trading/sessions.
 *   Almanac encrypts and stores them to trade on your behalf.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

function env(key, fallback = '') {
  return process.env[key] !== undefined && process.env[key] !== null ? process.env[key] : fallback;
}

function envFloat(key, fallback = 0) {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : fallback;
}

function envInt(key, fallback = 0) {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function envBool(key, fallback = false) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const config = {
  // ── Wallet ─────────────────────────────────────────────
  walletPrivateKey: env('WALLET_PRIVATE_KEY'),
  walletAddress: env('WALLET_ADDRESS'),
  funderAddress: env('FUNDER_ADDRESS'),
  signatureType: envInt('SIGNATURE_TYPE', 0),

  // ── Polymarket API Credentials (L2) ────────────────────
  // Can be empty — will be auto-derived from private key at startup
  polyApiKey: env('POLY_API_KEY'),
  polyApiSecret: env('POLY_API_SECRET'),
  polyApiPassphrase: env('POLY_API_PASSPHRASE'),

  // ── Copy Trade Targets ─────────────────────────────────
  get targetWallets() {
    const raw = env('TARGET_WALLETS', env('COPY_TRADE_WALLETS', ''));
    if (!raw) return [];
    return raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  },

  // ── Trade Settings ─────────────────────────────────────
  sizeMultiplier: envFloat('SIZE_MULTIPLIER', envFloat('COPY_RATIO', 1.0)),
  maxPositionUsdc: envFloat('MAX_POSITION_USDC', envFloat('MAX_POSITION_USD', 5)),
  slippageTolerance: envFloat('SLIPPAGE_TOLERANCE', envFloat('SLIPPAGE', 0.02)),
  defaultOrderType: env('DEFAULT_ORDER_TYPE', 'FOK'),
  retryMaxAttempts: envInt('RETRY_MAX_ATTEMPTS', 3),
  retryDelayMs: envInt('RETRY_DELAY_MS', 100),
  maxSignalAgeSec: envInt('MAX_SIGNAL_AGE_SEC', 120),

  // ── 5-min Crypto Markets ───────────────────────────────
  enable5minMarkets: envBool('ENABLE_5MIN_MARKETS', true),
  maxPosition5minUsdc: envFloat('MAX_POSITION_5MIN_USDC', 3),

  // ── Anti-Double Order Tuning ───────────────────────────
  // All 4 layers work together. Layer 1 (txHash dedup) is always on.
  // These control layers 2-4. Lower = faster but less safety margin.
  processingLockMs: envInt('PROCESSING_LOCK_MS', 2000),    // Layer 2: atomic lock (min: 2000)
  debounceMs: envInt('DEBOUNCE_MS', 500),                  // Layer 3: per-token BUY debounce (min: 200)
  buyCooldownSec: envFloat('BUY_COOLDOWN_SEC', 2),         // Layer 4: per-market BUY cooldown (min: 1)

  // ── Auto Redeem ────────────────────────────────────────
  autoRedeemEnabled: envBool('AUTO_REDEEM_ENABLED', true),
  redeemCheckIntervalSec: envInt('REDEEM_CHECK_INTERVAL_SEC', 60),

  // ── Kill Switch ────────────────────────────────────────
  maxDailyLossUsdc: envFloat('MAX_DAILY_LOSS_USDC', 200),
  maxOpenPositions: envInt('MAX_OPEN_POSITIONS', 20),
  killSwitchEnabled: envBool('KILL_SWITCH_ENABLED', true),

  // ── Endpoints ──────────────────────────────────────────
  polymarketClobUrl: env('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com'),
  polymarketGammaUrl: env('POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com'),
  polymarketDataUrl: env('POLYMARKET_DATA_URL', 'https://data-api.polymarket.com'),
  almanacBaseUrl: env('ALMANAC_BASE_URL', 'https://api.almanac.market/api'),
  chainId: envInt('CHAIN_ID', 137),

  // ── RPC ────────────────────────────────────────────────
  rpcUrl: env('RPC_URL', env('POLYGON_RPC_URL', 'https://polygon-rpc.com')),
  rpcWsUrl: env('RPC_WS_URL', ''),
  infuraApiKey: env('INFURA_API_KEY', ''),
  rpcFallback1: env('POLYGON_RPC_FALLBACK_1', 'https://polygon-rpc.com'),
  rpcFallback2: env('POLYGON_RPC_FALLBACK_2', 'https://rpc.ankr.com/polygon'),
  rpcFallback3: env('POLYGON_RPC_FALLBACK_3', 'https://polygon.llamarpc.com'),

  // ── Logging ────────────────────────────────────────────
  logLevel: env('LOG_LEVEL', 'info'),

  // ── Health ─────────────────────────────────────────────
  healthPort: envInt('HEALTH_PORT', 8081),

  // ── Derived ────────────────────────────────────────────
  get polymarketApiCredentials() {
    return {
      apiKey: this.polyApiKey,
      secret: this.polyApiSecret,
      passphrase: this.polyApiPassphrase,
    };
  },

  get infuraHttpUrl() {
    return this.infuraApiKey
      ? `https://polygon-mainnet.infura.io/v3/${this.infuraApiKey}`
      : '';
  },

  get infuraWsUrl() {
    return this.infuraApiKey
      ? `wss://polygon-mainnet.infura.io/ws/v3/${this.infuraApiKey}`
      : '';
  },

  /** Resolved primary HTTP RPC. Priority: manual > Infura > public. */
  get resolvedRpcUrl() {
    if (this.rpcUrl && !this.rpcUrl.includes('YOUR_KEY')) return this.rpcUrl;
    if (this.infuraApiKey) return this.infuraHttpUrl;
    return this.rpcFallback1;
  },

  /** Resolved WS RPC URL. */
  get resolvedWsUrl() {
    if (this.rpcWsUrl) return this.rpcWsUrl;
    if (this.infuraApiKey) return this.infuraWsUrl;
    return 'wss://polygon-bor-rpc.publicnode.com';
  },

  /** All fallback HTTP RPC URLs (excluding primary). */
  get rpcFallbackUrls() {
    const primary = this.resolvedRpcUrl;
    return [
      this.infuraHttpUrl,
      this.rpcFallback1,
      this.rpcFallback2,
      this.rpcFallback3,
    ].filter(u => u && u !== primary);
  },
};

export default config;
