# Polymarket Copy Trade Bot (Node.js)

Copy trading bot for Polymarket prediction markets via Almanac trading terminal.

## Requirements

- **Node.js** v18 or higher
- **npm** v9 or higher
- A Polymarket account with funds (USDC on Polygon)
- Your wallet private key (exported from Polymarket)
- Target wallet address(es) to copy

## Installation

```bash
# 1. Clone / extract the project
cd polymarket-bot

# 2. Install dependencies
npm install

# 3. Copy and edit config
cp env.example .env
nano .env
```

## Dependencies

The bot uses these npm packages (all installed automatically with `npm install`):

| Package | Purpose |
|---------|---------|
| `axios` | HTTP client for Almanac + Polymarket API calls |
| `ethers` | Wallet management, EIP-712 signing, RPC provider |
| `ws` | WebSocket client for on-chain event listening |
| `dotenv` | Load configuration from .env file |
| `p-retry` | Exponential backoff retry (fixes 502 errors) |
| `p-limit` | Concurrency limiter |
| `bottleneck` | API rate limiting (prevents bans) |
| `winston` | Structured logging to console + file |

No Python required. No additional system dependencies.

## Setup (3 Steps)

### Step 1: Get your private key

1. Go to [polymarket.com](https://polymarket.com)
2. Click **Cash** → three dots menu → **Export Private Key**
3. Copy the key

### Step 2: Configure .env

```bash
nano .env
```

Fill in these **required** fields only:

```env
# Required
WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
WALLET_ADDRESS=0xYOUR_WALLET_ADDRESS
FUNDER_ADDRESS=0xYOUR_PROXY_WALLET_ADDRESS
TARGET_WALLETS=0xTARGET_WALLET_1,0xTARGET_WALLET_2

# Optional (tune as needed)
MAX_POSITION_USDC=5
SIZE_MULTIPLIER=1.0
```

**API credentials (POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE) are auto-derived.** Leave them empty. The bot will generate them from your private key on first startup and save them to `.env` automatically.

### Step 3: Run

```bash
npm start
```

That's it. The bot will:
1. Auto-derive your Polymarket API credentials (saved to .env)
2. Create an Almanac trading session
3. Start listening to target wallet trades
4. Copy trades automatically

## Usage

```bash
# Live trading
npm start

# Dry run (simulate without placing orders)
DRY_RUN=true npm start

# Check config
node src/index.js --status

# Manually derive API keys (if auto-derive fails)
npm run keys

# Health check (while bot is running)
curl http://localhost:8081/health
curl http://localhost:8081/metrics
curl http://localhost:8081/positions
```

## Configuration Reference

### Required

| Variable | Description |
|----------|-------------|
| `WALLET_PRIVATE_KEY` | Your wallet private key |
| `WALLET_ADDRESS` | Your EOA wallet address |
| `FUNDER_ADDRESS` | Proxy wallet that holds your funds |
| `TARGET_WALLETS` | Comma-separated wallet addresses to copy |

### Auto-Derived (leave empty)

| Variable | Description |
|----------|-------------|
| `POLY_API_KEY` | Auto-derived from private key on first run |
| `POLY_API_SECRET` | Auto-derived from private key on first run |
| `POLY_API_PASSPHRASE` | Auto-derived from private key on first run |

### Trade Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SIZE_MULTIPLIER` | `1.0` | Multiply target's trade size by this |
| `MAX_POSITION_USDC` | `5` | Max USDC per position (regular markets) |
| `SLIPPAGE_TOLERANCE` | `0.02` | Slippage tolerance (2%) |
| `DEFAULT_ORDER_TYPE` | `FOK` | FOK (fill-or-kill) or GTC (good-till-cancel) |

### 5-Minute Crypto Markets

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_5MIN_MARKETS` | `true` | Set `false` to skip all 5-min crypto markets |
| `MAX_POSITION_5MIN_USDC` | `3` | Max USDC per 5-min market position |

### Anti-Double Order Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PROCESSING_LOCK_MS` | `2000` | Layer 2: atomic lock duration (ms) |
| `DEBOUNCE_MS` | `500` | Layer 3: BUY debounce per token (ms) |
| `BUY_COOLDOWN_SEC` | `2` | Layer 4: BUY cooldown per market (seconds) |

### Safety

| Variable | Default | Description |
|----------|---------|-------------|
| `KILL_SWITCH_ENABLED` | `true` | Auto-stop on daily loss limit |
| `MAX_DAILY_LOSS_USDC` | `200` | Daily loss threshold |
| `MAX_OPEN_POSITIONS` | `20` | Max concurrent open positions |
| `AUTO_REDEEM_ENABLED` | `true` | Auto-redeem resolved winning positions |

### Network

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | public fallback | Polygon RPC URL (Alchemy/Infura/etc) |
| `ALMANAC_BASE_URL` | `https://api.almanac.market/api` | Almanac API |
| `HEALTH_PORT` | `8081` | Healthcheck HTTP server port |

## Architecture

```
Target Wallet(s)
    │
    ▼
┌──────────────────────────┐
│  TradeListener            │  WS on-chain events + REST polling
│  src/tradeListener.js     │  4-layer anti-double protection
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  CopyTradeEngine          │  Size/price validation, position limits
│  src/copytrade.js         │  In-flight balance tracking
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐     ┌──────────────────────┐
│  APIClient                │────→│ Almanac API           │
│  src/apiClient.js         │     │ /v1/trading/orders    │
│  Auto fee-learn + retry   │     └──────────────────────┘
└──────────────────────────┘
```

## VPS Deployment

```bash
# Using systemd (Ubuntu)
sudo cat > /etc/systemd/system/polymarket-bot.service << 'EOF'
[Unit]
Description=Polymarket Copy Trade Bot
After=network-online.target

[Service]
Type=simple
User=polybot
WorkingDirectory=/home/polybot/polymarket-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl start polymarket-bot
sudo systemctl enable polymarket-bot

# View logs
journalctl -u polymarket-bot -f
```

Recommended VPS: NYC location, 2+ vCPU, 4GB RAM (Hetzner, Vultr, DigitalOcean).

## Disclaimer

This software is for educational purposes only. Trading involves significant financial risk. Never trade with funds you cannot afford to lose.
