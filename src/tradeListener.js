/**
 * tradeListener.js — Listen for target wallet trades.
 *
 * Two methods:
 *   1. PRIMARY: WebSocket subscription to CTF OrderFilled events (~2s delay)
 *   2. FALLBACK: REST API polling (~26s delay, catches anything WS missed)
 *
 * BUG FIXES:
 *   4. DOUBLE ORDERS — deduplication via txHash+logIndex Set + 3s debounce
 */

import WebSocket from 'ws';
import config from './config.js';
import { logger, logEvent } from './utils.js';

// ── Constants ─────────────────────────────────────────────
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const CTF_ADDRESSES = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  '0xC5d563A36AE78145C45a50134d48A1215220f80a',
];
const FREE_WS_URLS = [
  'wss://polygon.drpc.org',
  'wss://polygon-bor-rpc.publicnode.com',
];

class TradeListener {
  /**
   * @param {import('./apiClient.js').default} apiClient
   * @param {string[]} wallets - target wallet addresses
   */
  constructor(apiClient, wallets) {
    this._api = apiClient;
    this._wallets = wallets.map(w => w.toLowerCase());
    this._targetSet = new Set(this._wallets);
    this._running = false;
    this._handlers = [];

    // FIX 4: DOUBLE ORDERS — deduplication system
    // trade_id = txHash + "_" + logIndex (or txHash for REST)
    this._processedTrades = new Set();
    this._maxProcessedSize = 10000;

    // Atomic lock: prevents WS + REST racing on same trade_id
    this._processingLock = new Set();

    // Debounce: tokenId → last order timestamp
    this._debounceMap = new Map();

    // Per-wallet seen trades (for REST polling warmup)
    this._seenTrades = {};
    for (const w of this._wallets) this._seenTrades[w] = new Set();
    this._warmedUp = {};
    for (const w of this._wallets) this._warmedUp[w] = true; // start warmed

    this._ws = null;
    this._wsUrlIndex = 0;
    this._startTime = Date.now() / 1000;
    this._pollInterval = 2000; // 2s
  }

  onNewTrade(handler) {
    this._handlers.push(handler);
  }

  async start() {
    this._running = true;
    this._startTime = Date.now() / 1000;

    // Start WS listener
    this._wsLoop();

    // Start REST pollers (one per wallet)
    for (const wallet of this._wallets) {
      this._pollLoop(wallet);
    }

    logger.info(`Watching ${this._wallets.length} wallets (WS + REST)`);
  }

  async stop() {
    this._running = false;
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
    }
  }

  // ═══════════════════════════════════════════════════════
  // FIX 4: DEDUPLICATION
  // ═══════════════════════════════════════════════════════

  /**
   * Check if trade was already processed. Returns true if duplicate.
   * Uses atomic lock to prevent WS + REST racing on same trade.
   */
  _isDuplicate(tradeId) {
    if (!tradeId) return true;
    if (this._processedTrades.has(tradeId)) return true;

    // Atomic lock: if another handler is currently processing this ID, skip
    if (this._processingLock.has(tradeId)) return true;
    this._processingLock.add(tradeId);

    // Release lock after configured duration (must be >= REST poll interval)
    setTimeout(() => this._processingLock.delete(tradeId), config.processingLockMs);

    // GC if too large
    if (this._processedTrades.size > this._maxProcessedSize) {
      const arr = [...this._processedTrades];
      this._processedTrades = new Set(arr.slice(-5000));
    }

    this._processedTrades.add(tradeId);
    return false;
  }

  /**
   * Check debounce window for a token BUY.
   * SELL is NEVER debounced — exits must be immediate.
   * Returns true if within debounce period.
   */
  _isDebounced(tokenId, side = 'BUY') {
    // SELL is never debounced — we must exit positions ASAP
    if (side === 'SELL') return false;

    const now = Date.now();
    const lastTime = this._debounceMap.get(tokenId) || 0;
    if (now - lastTime < config.debounceMs) return true;
    this._debounceMap.set(tokenId, now);
    return false;
  }

  // ═══════════════════════════════════════════════════════
  // WEBSOCKET (PRIMARY — on-chain OrderFilled events)
  // ═══════════════════════════════════════════════════════

  async _wsLoop() {
    while (this._running) {
      const wsUrl = config.resolvedWsUrl || FREE_WS_URLS[this._wsUrlIndex];

      try {
        await this._connectWs(wsUrl);
      } catch (err) {
        logger.warn(`On-chain WS error: ${err.message}`);
        this._wsUrlIndex = (this._wsUrlIndex + 1) % FREE_WS_URLS.length;
        logger.info(`Switching WS to: ${FREE_WS_URLS[this._wsUrlIndex].slice(0, 30)}...`);
      }

      if (this._running) {
        await sleep(2000);
      }
    }
  }

  _connectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: 10000,
        perMessageDeflate: false, // disable for latency
      });

      this._ws = ws;
      let subCount = 0;
      let subId = 1;

      const paddedWallets = this._wallets.map(w => '0x' + w.slice(2).padStart(64, '0'));

      ws.on('open', async () => {
        logger.info(`On-chain WS connected to ${wsUrl.slice(0, 40)}...`);

        try {
          for (const padded of paddedWallets) {
            // Subscribe as maker (topic[2])
            ws.send(JSON.stringify({
              jsonrpc: '2.0', id: subId++,
              method: 'eth_subscribe',
              params: ['logs', {
                address: CTF_ADDRESSES,
                topics: [ORDER_FILLED_TOPIC, null, padded],
              }],
            }));
            subCount++;

            // Subscribe as taker (topic[3])
            ws.send(JSON.stringify({
              jsonrpc: '2.0', id: subId++,
              method: 'eth_subscribe',
              params: ['logs', {
                address: CTF_ADDRESSES,
                topics: [ORDER_FILLED_TOPIC, null, null, padded],
              }],
            }));
            subCount++;
          }
          logger.info(`On-chain WS: ${subCount} subscriptions for ${this._wallets.length} wallets`);
        } catch (err) {
          logger.error(`WS subscribe error: ${err.message}`);
        }
      });

      ws.on('message', async (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.params && data.params.result) {
            await this._handleWsEvent(data.params.result);
          }
        } catch { /* ignore parse errors */ }
      });

      ws.on('close', () => {
        logger.debug('On-chain WS disconnected');
        resolve();
      });

      ws.on('error', (err) => {
        reject(err);
      });

      // Ping keepalive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);

      ws.on('close', () => clearInterval(pingInterval));
    });
  }

  async _handleWsEvent(result) {
    const topics = result.topics || [];
    if (topics.length < 4) return;

    const maker = '0x' + topics[2].slice(-40);
    const taker = '0x' + topics[3].slice(-40);

    if (!this._targetSet.has(maker.toLowerCase()) && !this._targetSet.has(taker.toLowerCase())) {
      return;
    }

    const txHash = result.transactionHash || '';
    const logIndex = result.logIndex || '0';
    const tradeId = `${txHash}_${logIndex}`;

    // FIX 4: DEDUPLICATION
    if (this._isDuplicate(tradeId)) return;

    const source = this._targetSet.has(maker.toLowerCase()) ? maker.toLowerCase() : taker.toLowerCase();

    // Parse event data
    let raw = result.data || '0x';
    if (raw.startsWith('0x')) raw = raw.slice(2);
    if (raw.length < 320) return;

    const sideNum = parseInt(raw.slice(0, 64), 16);
    const tokenId = BigInt('0x' + raw.slice(64, 128)).toString();
    const makerFilled = parseInt(raw.slice(128, 192), 16);
    const takerFilled = parseInt(raw.slice(192, 256), 16);

    // Skip token=0
    if (tokenId === '0') return;

    const side = sideNum === 0 ? 'BUY' : 'SELL';

    let price, size, usdc;
    if (side === 'BUY') {
      price = takerFilled > 0 ? makerFilled / takerFilled : 0;
      size = takerFilled / 1_000_000;
      usdc = makerFilled / 1_000_000;
    } else {
      price = makerFilled > 0 ? takerFilled / makerFilled : 0;
      size = makerFilled / 1_000_000;
      usdc = takerFilled / 1_000_000;
    }

    if (price <= 0 || price >= 1.0) return;

    // FIX 4: DEBOUNCE (BUY only — SELL never blocked)
    if (this._isDebounced(tokenId, side)) {
      logger.debug(`[DEBOUNCE] Skipping ${side} ${tokenId.slice(0, 16)}...`);
      return;
    }

    logger.info(`🔔 ${side} ${size.toFixed(2)}@${price.toFixed(2)} | tx=${txHash.slice(0, 12)}`);

    const tradeEvent = {
      transactionHash: txHash,
      conditionId: '',
      asset: tokenId,
      side,
      price,
      size,
      usdcSize: usdc,
      type: 'TRADE',
      timestamp: Date.now() / 1000,
      _source_wallet: source,
      _onchain: true,
    };

    await this._dispatch(tradeEvent);
  }

  // ═══════════════════════════════════════════════════════
  // REST POLLING (FALLBACK)
  // ═══════════════════════════════════════════════════════

  async _pollLoop(wallet) {
    let consecutiveErrors = 0;

    while (this._running) {
      try {
        const trades = await this._api.getTargetTrades(wallet, 30);
        consecutiveErrors = 0;

        if (!this._warmedUp[wallet]) {
          for (const trade of trades) {
            const tid = this._getTradeId(trade);
            if (tid) this._seenTrades[wallet].add(tid);
          }
          this._warmedUp[wallet] = true;
          logger.info(`REST warmed up ${wallet.slice(0, 10)}...: ${this._seenTrades[wallet].size} trades`);
          await sleep(this._pollInterval);
          continue;
        }

        for (const trade of trades) {
          const tid = this._getTradeId(trade);
          if (!tid || this._seenTrades[wallet].has(tid)) continue;

          // Skip old trades
          let tradeTs = parseFloat(trade.timestamp || 0);
          if (tradeTs > 1e12) tradeTs /= 1000;
          if (tradeTs > 0 && tradeTs < this._startTime - 30) {
            this._seenTrades[wallet].add(tid);
            continue;
          }

          this._seenTrades[wallet].add(tid);

          // GC
          if (this._seenTrades[wallet].size > 5000) {
            const arr = [...this._seenTrades[wallet]];
            this._seenTrades[wallet] = new Set(arr.slice(-3000));
          }

          // FIX 4: DEDUPLICATION — also check global processed set
          if (this._isDuplicate(tid)) continue;

          const tokenId = trade.asset || trade.assetId || trade.asset_id || trade.tokenId || '';
          const tradeSide = (trade.side || trade.type || 'BUY').toUpperCase();
          if (this._isDebounced(tokenId, tradeSide)) continue;

          trade._source_wallet = wallet;
          await this._dispatch(trade);
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors <= 3) {
          logger.warn(`REST poll ${wallet.slice(0, 10)} error: ${err.message}`);
        }
        if (consecutiveErrors > 10) {
          await sleep(30000);
          consecutiveErrors = 0;
        }
      }

      await sleep(this._pollInterval);
    }
  }

  _getTradeId(trade) {
    return trade.transactionHash || trade.id || trade.transaction_hash || '';
  }

  // ═══════════════════════════════════════════════════════
  // DISPATCH
  // ═══════════════════════════════════════════════════════

  async _dispatch(tradeEvent) {
    for (const handler of this._handlers) {
      try {
        await Promise.race([
          handler(tradeEvent),
          sleep(60000).then(() => { throw new Error('Handler timeout'); }),
        ]);
      } catch (err) {
        logger.error(`Handler error: ${err.message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default TradeListener;
