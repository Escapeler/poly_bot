/**
 * healthcheck.js — Lightweight HTTP healthcheck server.
 *
 * Endpoints:
 *   GET /health     — overall status
 *   GET /metrics    — trading metrics
 *   GET /positions  — open positions
 */

import { createServer } from 'http';
import config from './config.js';
import { logger } from './utils.js';

class HealthCheckServer {
  /**
   * @param {import('./copytrade.js').default} copytrade
   * @param {boolean} wsConnected - function returning WS connection status
   * @param {import('./apiClient.js').default} apiClient
   */
  constructor(copytrade, isWsConnected, apiClient) {
    this._copytrade = copytrade;
    this._isWsConnected = isWsConnected;
    this._apiClient = apiClient;
    this._server = null;
    this._port = config.healthPort;
  }

  async start() {
    this._server = createServer((req, res) => {
      const url = req.url || '/';
      let body, status;

      if (url === '/health') {
        body = this._healthResponse();
        status = 200;
      } else if (url === '/metrics') {
        body = this._metricsResponse();
        status = 200;
      } else if (url === '/positions') {
        body = this._positionsResponse();
        status = 200;
      } else {
        body = JSON.stringify({ error: 'not found' });
        status = 404;
      }

      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
      });
      res.end(body);
    });

    this._server.listen(this._port, '0.0.0.0', () => {
      logger.info(`Healthcheck server on port ${this._port}`);
    });
  }

  async stop() {
    if (this._server) {
      return new Promise(resolve => this._server.close(resolve));
    }
  }

  _healthResponse() {
    const m = this._copytrade.metrics;
    const uptime = Date.now() / 1000 - m.startedAt;
    const wsOk = this._isWsConnected();
    const kill = this._copytrade.isKillSwitched;
    const healthy = wsOk && !kill;

    return JSON.stringify({
      status: healthy ? 'healthy' : 'degraded',
      uptime_seconds: Math.round(uptime),
      websocket_connected: wsOk,
      kill_switch_active: kill,
      circuit_breaker_open: this._apiClient && this._apiClient._circuitOpen ? true : false,
      open_positions: Object.keys(this._copytrade.openPositions).length,
      trades_copied: m.totalTradesCopied,
      avg_latency_ms: Math.round(m.avgLatencyMs * 10) / 10,
    });
  }

  _metricsResponse() {
    const m = this._copytrade.metrics;
    return JSON.stringify({
      trades_copied: m.totalTradesCopied,
      orders_placed: m.totalOrdersPlaced,
      orders_filled: m.totalOrdersFilled,
      orders_failed: m.totalOrdersFailed,
      redeems: m.totalRedeems,
      realized_pnl: Math.round(m.realizedPnl * 10000) / 10000,
      win_rate: Math.round(this._copytrade.winRate * 10000) / 10000,
      avg_latency_ms: Math.round(m.avgLatencyMs * 100) / 100,
      total_volume_usdc: Math.round(m.totalVolumeUsdc * 100) / 100,
      daily_loss: Math.round(m.dailyLoss * 100) / 100,
    });
  }

  _positionsResponse() {
    const positions = Object.entries(this._copytrade.openPositions).map(([mid, pos]) => ({
      market_id: mid.slice(0, 20) + '...',
      side: pos.side,
      size: pos.size,
      entry_price: pos.entryPrice,
      source: (pos.sourceWallet || '').slice(0, 12) + '...',
    }));
    return JSON.stringify({ count: positions.length, positions });
  }
}

export default HealthCheckServer;
