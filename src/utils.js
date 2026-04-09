/**
 * utils.js — Shared utilities: logging, HMAC signing, timing, nonce.
 */

import { createHmac, randomBytes } from 'crypto';
import winston from 'winston';
import config from './config.js';

// ═══════════════════════════════════════════════════════════
// LOGGING (Winston)
// ═══════════════════════════════════════════════════════════

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} | ${level.toUpperCase().padEnd(7)} | ${message}`;
    }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} | ${level.padEnd(17)} | ${message}`;
        }),
      ),
    }),
    new winston.transports.File({
      filename: 'logs/bot.log',
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 5,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
    }),
  ],
});

export { logger };

// ═══════════════════════════════════════════════════════════
// HMAC SIGNING (Polymarket L2 Auth)
// ═══════════════════════════════════════════════════════════

/**
 * Create HMAC-SHA256 signature for Polymarket CLOB L2 auth.
 * Format: timestamp + method + path + body
 */
export function createHmacSignature(secret, timestamp, method, path, body = '') {
  const message = `${timestamp}${method}${path}${body}`;
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Build authenticated headers for Polymarket CLOB L2 requests.
 */
export function buildL2Headers(apiKey, apiSecret, apiPassphrase, method = 'GET', path = '/', body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmacSignature(apiSecret, timestamp, method, path, body);
  return {
    'POLY_ADDRESS': config.funderAddress,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': '0',
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': apiPassphrase,
  };
}

/**
 * Build Almanac session headers.
 */
export function buildAlmanacHeaders(sessionId, walletAddress) {
  return {
    'x-session-id': sessionId,
    'x-wallet-address': walletAddress,
    'Content-Type': 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════
// NONCE / TIMING
// ═══════════════════════════════════════════════════════════

export function generateNonce() {
  return randomBytes(16).toString('hex');
}

export function timestampMs() {
  return Date.now();
}

export function timestampSec() {
  return Math.floor(Date.now() / 1000);
}

// ═══════════════════════════════════════════════════════════
// LATENCY TIMER
// ═══════════════════════════════════════════════════════════

export class LatencyTimer {
  constructor() {
    this.startNs = 0n;
    this.elapsedMs = 0;
  }

  start() {
    this.startNs = process.hrtime.bigint();
    return this;
  }

  stop() {
    const endNs = process.hrtime.bigint();
    this.elapsedMs = Number(endNs - this.startNs) / 1_000_000;
    return this.elapsedMs;
  }
}

// ═══════════════════════════════════════════════════════════
// JSON LOGGING HELPERS
// ═══════════════════════════════════════════════════════════

export function logEvent(event, data = {}) {
  const entry = { event, ts: timestampMs(), ...data };
  logger.info(JSON.stringify(entry));
}

export function logOrderPlaced(marketId, side, price, size, latencyMs, orderId = null) {
  logEvent('order_placed', { marketId, side, price, size, latency_ms: Math.round(latencyMs * 100) / 100, orderId });
}

export function logCopyTrade(sourceWallet, marketId, side, price, originalSize, copiedSize, latencyMs) {
  logEvent('copy_trade', {
    sourceWallet, marketId, side, price,
    originalSize, copiedSize,
    latency_ms: Math.round(latencyMs * 100) / 100,
  });
}
