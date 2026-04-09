/**
 * apiClient.js — Almanac + Polymarket API client.
 *
 * KEY DISCOVERY from Almanac API:
 *   - Almanac markets use NUMERIC IDs (e.g. "629059")
 *   - Almanac exposes clob_token_ids which match Polymarket token IDs
 *
 * MAPPING STRATEGY:
 *   signal.token_id → match clob_token_ids in Almanac → get Almanac market "id"
 *
 * BUG FIXES:
 *   1. INSUFFICIENT_BALANCE — checked before every order
 *   2. INVALID_FEE_RATE — auto-learned from errors + cached per market
 *   3. 502 BAD GATEWAY — exponential backoff retry (p-retry)
 */

import axios from 'axios';
import pRetry from 'p-retry';
import Bottleneck from 'bottleneck';
import config from './config.js';
import walletManager from './wallet.js';
import { logger, generateNonce, LatencyTimer, logEvent, buildAlmanacHeaders } from './utils.js';

const ALMANAC_API_URL = config.almanacBaseUrl;
const PRICE_BUFFER = 0.01;

// ── Rate Limiter ──────────────────────────────────────────
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 100,        // 100ms between requests = 10 req/s
  reservoir: 50,       // 50 requests per window
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 50,
});

class APIClient {
  constructor() {
    this._http = null;
    this._session = null;        // { sessionId, walletAddress, proxyWallet }
    this._marketCache = {};      // conditionId → marketInfo
    this._tokenToAlmanac = {};   // tokenId → { almanacId, negRisk, eventId }
    this._almanacLoaded = 0;
    this._missingTokens = new Set();
    this._marketFeeRates = {};   // almanacId → bps (FIX: INVALID_FEE_RATE)
    this._cachedBalance = null;  // { usdc, timestamp }  (FIX: INSUFFICIENT_BALANCE)

    // ── ANTI-SLIPPAGE: mid-price cache ────────────────
    this._midPriceCache = {};    // tokenId → { price, timestamp }
    this._MID_PRICE_TTL = 5000;  // 5 second cache

    // ── CIRCUIT BREAKER ───────────────────────────────
    this._consecutiveErrors = 0;
    this._circuitOpen = false;
    this._circuitOpenUntil = 0;
    this._CIRCUIT_THRESHOLD = 5;     // open after 5 consecutive errors
    this._CIRCUIT_COOLDOWN = 30000;  // 30 second cooldown
  }

  async start() {
    this._http = axios.create({
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    logger.info('API client initialized');
  }

  async stop() {
    this._http = null;
  }

  // ═══════════════════════════════════════════════════════
  // ALMANAC MARKET INDEX
  // Maps token_id → Almanac market ID
  // ═══════════════════════════════════════════════════════

  async loadAlmanacMarkets() {
    let offset = 0;
    const pageSize = 100;
    let totalIndexed = 0;
    const maxOffset = 5000;

    logger.info('Loading Almanac market index...');

    while (offset <= maxOffset) {
      try {
        const resp = await this._request('GET', `${ALMANAC_API_URL}/markets`, {
          params: { limit: pageSize, offset },
        });
        const data = resp && resp.data || resp;
        const markets = Array.isArray(data) ? data : [];

        if (markets.length === 0) break;

        for (const m of markets) {
          const almanacId = String(m.id || '');
          const tokenIds = m.clob_token_ids || [];
          const negRisk = Boolean(m.neg_risk);
          const eventId = String(m.event_id || '');

          if (!almanacId || !tokenIds.length) continue;

          for (const tid of tokenIds) {
            this._tokenToAlmanac[String(tid)] = { almanacId, negRisk, eventId };
          }
          totalIndexed++;
        }
        offset += pageSize;
      } catch (err) {
        logger.warn(`Market load failed at offset ${offset}: ${err.message}`);
        break;
      }
    }

    // Also load 5-minute recurring markets (BTC, ETH, SOL up/down)
    await this._load5minMarkets();

    const uniqueMarkets = new Set(Object.values(this._tokenToAlmanac).map(v => v.almanacId)).size;
    this._almanacLoaded = Date.now();
    logger.info(`Almanac index: ${uniqueMarkets} markets, ${Object.keys(this._tokenToAlmanac).length} token mappings`);
    return uniqueMarkets;
  }

  async _load5minMarkets() {
    try {
      const resp = await this._request('GET', `${ALMANAC_API_URL}/v1/search/events`, {
        params: { recurrence: '5m', sort: 'endDate', sortOrder: 'asc', limit: 100 },
      });
      const events = resp && resp.events || [];
      let count = 0;
      for (const event of events) {
        for (const m of (event.markets || [])) {
          const almanacId = String(m.id || '');
          const tokenIds = m.clob_token_ids || [];
          if (!almanacId || !tokenIds.length) continue;
          for (const tid of tokenIds) {
            this._tokenToAlmanac[String(tid)] = {
              almanacId,
              negRisk: Boolean(m.neg_risk),
              eventId: String(m.event_id || event.id || ''),
            };
          }
          // 5-min crypto markets always require 1000bps fee
          this._marketFeeRates[almanacId] = 1000;
          count++;
        }
      }
      if (count) logger.info(`Loaded ${count} 5-min crypto markets`);
    } catch (err) {
      logger.debug(`5-min markets load failed: ${err.message}`);
    }
  }

  resolveAlmanacId(tokenId) {
    const entry = this._tokenToAlmanac[String(tokenId)];
    return entry ? entry.almanacId : null;
  }

  getAlmanacNegRisk(tokenId) {
    const entry = this._tokenToAlmanac[String(tokenId)];
    return entry ? entry.negRisk : false;
  }

  get almanacIndexSize() { return Object.keys(this._tokenToAlmanac).length; }

  get almanacIndexAge() {
    return this._almanacLoaded ? Date.now() - this._almanacLoaded : 999999;
  }

  async _dynamicResolve(tokenId) {
    // Don't permanently blacklist — 5-min markets appear every 5 mins
    // Only skip if we checked in the last 10 seconds
    const lastMiss = this._missingTokenTimestamps && this._missingTokenTimestamps[tokenId] || 0;
    if (Date.now() - lastMiss < 10000) return null;

    // Try 5-min markets first (single API call, fast)
    await this._load5minMarkets();
    let result = this.resolveAlmanacId(tokenId);
    if (result) return result;

    // Quick search newest regular markets (only first page — speed matters)
    try {
      const resp = await this._request('GET', `${ALMANAC_API_URL}/markets`, {
        params: { limit: 50, offset: 0 },
      });
      const data = resp && resp.data || resp;
      const markets = Array.isArray(data) ? data : [];
      for (const m of markets) {
        const aid = String(m.id || '');
        const tids = m.clob_token_ids || [];
        if (!aid || !tids.length) continue;
        for (const tid of tids) {
          this._tokenToAlmanac[String(tid)] = {
            almanacId: aid,
            negRisk: Boolean(m.neg_risk),
            eventId: String(m.event_id || ''),
          };
        }
      }
      result = this.resolveAlmanacId(tokenId);
      if (result) return result;
    } catch { /* ignore */ }

    // Track miss timestamp (not permanent blacklist)
    if (!this._missingTokenTimestamps) this._missingTokenTimestamps = {};
    this._missingTokenTimestamps[tokenId] = Date.now();
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // BALANCE CHECKING (FIX: INSUFFICIENT_BALANCE)
  // ═══════════════════════════════════════════════════════

  /**
   * Get USDC balance with 60-second cache to minimize RPC calls.
   * At 60s cache: ~1440 calls/day (vs 8640 at 10s).
   * Force refresh available via forceRefresh param.
   */
  async getAvailableBalance(forceRefresh = false) {
    const now = Date.now();
    const CACHE_TTL = 60000; // 60 seconds (OPTIMIZED: was 10s, saves ~7200 CU/day)

    if (!forceRefresh && this._cachedBalance && (now - this._cachedBalance.timestamp) < CACHE_TTL) {
      return this._cachedBalance.usdc;
    }
    try {
      const usdc = await walletManager.getUsdcBalance();
      this._cachedBalance = { usdc, timestamp: now };
      return usdc;
    } catch (err) {
      logger.warn(`Balance check failed: ${err.message}`);
      return this._cachedBalance ? this._cachedBalance.usdc : 0;
    }
  }

  // ═══════════════════════════════════════════════════════
  // SESSION
  // ═══════════════════════════════════════════════════════

  async createAlmanacSession() {
    const walletAddr = config.walletAddress;
    const message = 'Create Almanac trading session';

    const signature = await walletManager.signMessage(message);
    const sig = signature.startsWith('0x') ? signature : '0x' + signature;

    const body = {
      signature: sig,
      message,
      walletAddress: walletAddr,
      nonce: generateNonce(),
      timestamp: Math.floor(Date.now() / 1000),
      apiCredentials: config.polymarketApiCredentials,
    };

    const resp = await this._request('POST', `${ALMANAC_API_URL}/v1/trading/sessions`, { data: body });
    const data = resp && resp.data || resp;

    this._session = {
      sessionId: data.sessionId || '',
      walletAddress: data.walletAddress || walletAddr,
      proxyWallet: data.proxyWallet || config.funderAddress,
    };

    logger.info(`Session OK: ${this._session.sessionId.slice(0, 16)}... proxy=${this._session.proxyWallet.slice(0, 12)}...`);
    return this._session;
  }

  // ═══════════════════════════════════════════════════════
  // ANTI-SLIPPAGE: Mid-price validation
  // ═══════════════════════════════════════════════════════

  /**
   * Fetch current mid-price for a token from CLOB.
   * Used to validate signal price hasn't moved too much.
   * 5-second cache to avoid excessive calls.
   */
  async getMidPrice(tokenId) {
    const now = Date.now();
    const cached = this._midPriceCache[tokenId];
    if (cached && (now - cached.timestamp) < this._MID_PRICE_TTL) {
      return cached.price;
    }

    try {
      const resp = await this._request('GET', `${config.polymarketClobUrl}/midpoint`, {
        params: { token_id: tokenId },
      });
      const mid = parseFloat((resp && resp.mid != null) ? resp.mid : ((resp && resp.price != null) ? resp.price : 0));
      if (mid > 0 && mid < 1) {
        this._midPriceCache[tokenId] = { price: mid, timestamp: now };
        return mid;
      }
    } catch {
      // Non-critical — fall through to signal price
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // CIRCUIT BREAKER
  // ═══════════════════════════════════════════════════════

  _checkCircuitBreaker() {
    if (!this._circuitOpen) return false;
    if (Date.now() > this._circuitOpenUntil) {
      this._circuitOpen = false;
      this._consecutiveErrors = 0;
      logger.info('Circuit breaker CLOSED — resuming orders');
      return false;
    }
    return true; // circuit still open, skip order
  }

  _recordSuccess() {
    this._consecutiveErrors = 0;
    if (this._circuitOpen) {
      this._circuitOpen = false;
      logger.info('Circuit breaker CLOSED after success');
    }
  }

  _recordError() {
    this._consecutiveErrors++;
    if (this._consecutiveErrors >= this._CIRCUIT_THRESHOLD && !this._circuitOpen) {
      this._circuitOpen = true;
      this._circuitOpenUntil = Date.now() + this._CIRCUIT_COOLDOWN;
      logger.warn(`Circuit breaker OPEN — ${this._consecutiveErrors} consecutive errors. Pausing ${this._CIRCUIT_COOLDOWN / 1000}s`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // PLACE ORDER (with all bug fixes + optimizations)
  // ═══════════════════════════════════════════════════════

  /**
   * Place an order via Almanac with:
   *   1. Balance pre-check (FIX: INSUFFICIENT_BALANCE)
   *   2. Fee rate from cache (FIX: INVALID_FEE_RATE)
   *   3. Retry with backoff (FIX: 502 BAD GATEWAY)
   *   4. Auto-learn fee from error response
   */
  async placeOrder(order) {
    if (!this._session) {
      return { success: false, errorMsg: 'No session', latencyMs: 0 };
    }

    // ── CIRCUIT BREAKER — skip if too many consecutive errors ──
    if (this._checkCircuitBreaker()) {
      return { success: false, errorMsg: 'Circuit breaker open — paused', latencyMs: 0 };
    }

    // ── FIX 1: INSUFFICIENT_BALANCE ─────────────────────
    const balance = await this.getAvailableBalance();
    const orderCost = order.size * order.price;
    if (order.side === 'BUY' && balance < orderCost) {
      if (balance < 1.0) {
        return { success: false, errorMsg: 'INSUFFICIENT_BALANCE', latencyMs: 0 };
      }
      // Reduce order size to fit available balance
      order.size = Math.floor((balance / order.price) * 100) / 100;
      if (order.size * order.price < 1.0) {
        return { success: false, errorMsg: 'INSUFFICIENT_BALANCE (below $1 min)', latencyMs: 0 };
      }
      logger.info(`📉 Reduced order size to ${order.size} (balance: $${balance.toFixed(2)})`);
    }

    // ── ANTI-SLIPPAGE: validate signal price vs current mid ──
    // ADAPTIVE: 5-min crypto markets and breaking news can move 20-50%.
    // We use dynamic threshold based on market type:
    //   - 5-min crypto (1000bps fee): allow up to 30% drift (these move fast)
    //   - Regular markets: allow up to 2x slippage tolerance
    const midPrice = await this.getMidPrice(order.tokenId);
    if (midPrice) {
      const drift = Math.abs(order.price - midPrice) / midPrice;
      const is5minMarket = (this._marketFeeRates[almanacId] || 0) >= 1000;
      const maxDrift = is5minMarket ? 0.30 : (config.slippageTolerance * 2);

      if (drift > maxDrift) {
        logger.info(`[SKIP] Slippage guard: signal=${order.price.toFixed(4)} mid=${midPrice.toFixed(4)} drift=${(drift * 100).toFixed(1)}% max=${(maxDrift * 100).toFixed(0)}%`);
        return { success: false, errorMsg: `Price drift too high (${(drift * 100).toFixed(1)}%)`, latencyMs: 0 };
      }

      // Only adjust price to mid for REGULAR markets.
      // For 5-min/volatile: trust the signal price (target knows something).
      if (!is5minMarket) {
        if (order.side === 'BUY') {
          order.price = Math.min(midPrice * (1 + config.slippageTolerance), 0.99);
        } else {
          order.price = Math.max(midPrice * (1 - config.slippageTolerance), 0.01);
        }
        order.price = Math.round(order.price * 10000) / 10000;
      }
      // For 5-min: keep signal price as-is (+ existing buffer from copytrade._adjustPrice)
    }

    // Resolve token_id → Almanac numeric market ID
    let almanacId = this.resolveAlmanacId(order.tokenId);
    if (!almanacId) {
      almanacId = await this._dynamicResolve(order.tokenId);
    }
    if (!almanacId) {
      return { success: false, errorMsg: `Token ${order.tokenId.slice(0, 20)}... not in Almanac index`, latencyMs: 0 };
    }

    // Override neg_risk from Almanac index
    order.negRisk = this.getAlmanacNegRisk(order.tokenId);

    // ── FIX 2: INVALID_FEE_RATE — use cached fee ───────
    const feeRateBps = this._marketFeeRates[almanacId] || 0;

    const timer = new LatencyTimer().start();

    try {
      const signed = await walletManager.signOrder({
        tokenId: order.tokenId,
        side: order.side,
        price: order.price,
        size: order.size,
        negRisk: order.negRisk,
        orderType: order.orderType || config.defaultOrderType,
        feeRateBps,
      });

      if (!signed) {
        return { success: false, errorMsg: 'EIP-712 sign failed', latencyMs: timer.stop() };
      }

      const payload = {
        marketId: almanacId,
        signedOrder: { signature: signed.signature, orderPayload: signed.orderPayload },
        orderType: order.orderType || config.defaultOrderType,
        userWalletAddress: config.walletAddress,
      };

      const headers = buildAlmanacHeaders(this._session.sessionId, this._session.walletAddress);

      // ── FIX 3: 502 BAD GATEWAY — retry with backoff ──
      let resp = await this._requestWithRetry(
        'POST',
        `${ALMANAC_API_URL}/v1/trading/orders`,
        { data: payload, headers },
        2,
      );

      let success = (resp && resp.success != null) ? resp.success : false;
      let error = resp && resp.error || '';
      let userMsg = resp && resp.userMessage || '';

      // Auto-learn fee rate from INVALID_FEE_RATE error and retry once
      if (!success && error.includes('INVALID_FEE_RATE')) {
        const match = userMsg.match(/(\d+)\s*basis points/);
        if (match) {
          const learnedBps = parseInt(match[1], 10);
          this._marketFeeRates[almanacId] = learnedBps;
          logger.info(`🔄 Learned fee=${learnedBps}bps for mkt=${almanacId}, retrying...`);

          const signed2 = await walletManager.signOrder({
            tokenId: order.tokenId,
            side: order.side,
            price: order.price,
            size: order.size,
            negRisk: order.negRisk,
            orderType: order.orderType || config.defaultOrderType,
            feeRateBps: learnedBps,
          });

          if (signed2) {
            payload.signedOrder = { signature: signed2.signature, orderPayload: signed2.orderPayload };
            const resp2 = await this._requestWithRetry(
              'POST',
              `${ALMANAC_API_URL}/v1/trading/orders`,
              { data: payload, headers },
              1,
            );
            success = (resp2 && resp2.success != null) ? resp2.success : false;
            error = resp2 && resp2.error || '';
            userMsg = resp2 && resp2.userMessage || '';
            resp = resp2;
          }
        }
      }

      const latencyMs = timer.stop();
      const orderId = (resp && resp.data) ? (resp.data.orderId || null) : null;

      const result = { success, orderId, errorMsg: error || userMsg, latencyMs };

      if (success) {
        // Invalidate balance cache after successful order
        this._cachedBalance = null;
        this._recordSuccess();
        logger.info(`✅ ${order.side} ${order.size}@${order.price} → mkt=${almanacId} | ${latencyMs.toFixed(0)}ms`);
      } else {
        this._recordError();
        logger.warn(`❌ ${order.side} ${order.size}@${order.price} → ${(error || userMsg).slice(0, 50)}`);
      }

      return result;
    } catch (err) {
      const latencyMs = timer.stop();
      logger.error(`Order error: ${err.message}`);
      return { success: false, errorMsg: err.message, latencyMs };
    }
  }

  async checkOrderFilled(orderId) {
    if (!this._session || !orderId) return null;
    try {
      const headers = buildAlmanacHeaders(this._session.sessionId, this._session.walletAddress);
      const resp = await this._request('GET', `${ALMANAC_API_URL}/v1/trading/orders`, {
        params: { limit: 10 },
        headers,
      });
      const orders = resp && resp.data || [];
      for (const o of (Array.isArray(orders) ? orders : [])) {
        const oid = o.orderId || o.order_id || o.id;
        if (oid === orderId) {
          return (o.status || 'unknown').toLowerCase();
        }
      }
      return 'unknown';
    } catch { return null; }
  }

  async cancelOrder(orderId) {
    if (!this._session || !orderId) return false;
    try {
      const headers = buildAlmanacHeaders(this._session.sessionId, this._session.walletAddress);
      const resp = await this._request('DELETE', `${ALMANAC_API_URL}/v1/trading/orders/${orderId}`, { headers });
      return (resp && resp.success != null) ? resp.success : false;
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════
  // MARKET DATA (Gamma — public)
  // ═══════════════════════════════════════════════════════

  async getMarket(conditionId) {
    if (this._marketCache[conditionId]) return this._marketCache[conditionId];
    try {
      const data = await this._request('GET', `${config.polymarketGammaUrl}/markets`, {
        params: { condition_id: conditionId },
      });
      const markets = Array.isArray(data) ? data : [];
      if (markets.length && typeof markets[0] === 'object') {
        const m = markets[0];
        const info = {
          conditionId: m.conditionId || conditionId,
          question: m.question || '',
          tokens: m.tokens || [],
          active: m.active !== undefined ? m.active : true,
          closed: m.closed !== undefined ? m.closed : false,
          resolved: m.resolved !== undefined ? m.resolved : false,
          negRisk: m.negRisk !== undefined ? m.negRisk : false,
          tickSize: m.minimumTickSize || '0.01',
        };
        this._marketCache[conditionId] = info;
        return info;
      }
    } catch { /* ignore */ }
    return null;
  }

  async getPositions() {
    if (!this._session) return [];
    try {
      const headers = buildAlmanacHeaders(this._session.sessionId, this._session.walletAddress);
      const resp = await this._request('GET', `${ALMANAC_API_URL}/v1/trading/positions`, {
        params: { filter: 'live', limit: 100 },
        headers,
      });
      const data = resp && resp.data || resp;
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  async getTargetTrades(wallet, limit = 20) {
    try {
      const data = await this._request('GET', `${config.polymarketDataUrl}/activity`, {
        params: { user: wallet, limit, type: 'trade' },
      });
      return Array.isArray(data) ? data : (data && data.history || []);
    } catch { return []; }
  }

  async getRedeemablePositions() {
    try {
      const resp = await this._request('GET', `${config.polymarketDataUrl}/positions`, {
        params: { user: config.funderAddress, limit: 100, sizeThreshold: '0.01' },
      });
      return Array.isArray(resp) ? resp : (resp && resp.positions || []);
    } catch { return []; }
  }

  // ═══════════════════════════════════════════════════════
  // HTTP (with rate limiting via Bottleneck)
  // ═══════════════════════════════════════════════════════

  async _request(method, url, opts = {}) {
    return limiter.schedule(async () => {
      const { data, params, headers: extraHeaders } = opts;
      const headers = { 'Content-Type': 'application/json', ...extraHeaders };
      const resp = await this._http.request({ method, url, data, params, headers });
      return resp.data;
    });
  }

  /**
   * FIX 3: 502 BAD GATEWAY — exponential backoff retry.
   * Uses p-retry: 1s → 2s → 4s → 8s → 16s
   */
  async _requestWithRetry(method, url, opts = {}, maxRetries = 5) {
    return pRetry(async () => {
      try {
        return await this._request(method, url, opts);
      } catch (err) {
        const status = err.response && err.response.status;

        // 4xx (except 429, 403) are not retried — return error body
        if (status && status >= 400 && status < 500 && status !== 429 && status !== 403) {
          logger.error(`[RETRY] ${status}: ${JSON.stringify(err.response && err.response.data || {}).slice(0, 300)}`);
          return err.response && err.response.data || { success: false, error: err.message };
        }

        // 429/403/5xx are retried
        logger.warn(`[RETRY] ${status || 'NETWORK'} error on ${method} ${url.slice(-40)}...`);
        throw err; // p-retry will catch and retry
      }
    }, {
      retries: maxRetries,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 16000,
      onFailedAttempt: (err) => {
        logger.warn(`[RETRY] Attempt ${err.attemptNumber}/${maxRetries + 1} failed: ${err.message}`);
      },
    }).catch(err => {
      return { success: false, error: err.message };
    });
  }
}

export default APIClient;
