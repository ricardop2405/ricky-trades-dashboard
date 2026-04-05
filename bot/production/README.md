# Ricky Trades — Production Bot

## Architecture

```
Your Computer / VPS              Lovable Cloud                Dashboard
┌─────────────────────┐         ┌──────────────────┐        ┌──────────────────┐
│ src/mev-engine.ts   │─writes─▶│ whale_trades     │◀─reads─│ Live Mempool     │
│ WebSocket → 8 DEXes │         │ bundle_results   │        │ Performance Log  │
│ Jito bundle backrun │         ├──────────────────┤        │ Stats + Charts   │
│                     │         │ prediction_mkts  │        │                  │
│ src/arb-engine.ts   │─writes─▶│ arb_opportunities│        │ Arb Dashboard    │
│ Polymarket+Manifold │         │ arb_executions   │        │                  │
└─────────────────────┘         └──────────────────┘        └──────────────────┘
```

## Quick Start

```bash
# 1. Copy this folder to your machine
cp -r bot/production ~/ricky-bot
cd ~/ricky-bot

# 2. Run setup
chmod +x setup.sh
./setup.sh

# 3. Configure environment
cp .env.example .env
nano .env   # Fill in your keys

# 4. Start both engines
npm start

# OR use PM2 for production
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## Required API Keys

| Key | Where to get it |
|-----|----------------|
| `SOLANA_PRIVATE_KEY` | Your Solana wallet (base58 format) |
| `HELIUS_RPC_URL` | [helius.dev](https://helius.dev) — free tier works |
| `HELIUS_HTTP_URL` | Same key, just `https://` instead of `wss://` |
| `SUPABASE_URL` | Already set: `https://vpfivkcxtwsnrtuhofyp.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | From your Lovable Cloud project settings |

## File Structure

```
production/
├── src/
│   ├── config.ts         # Env var loading + validation
│   ├── constants.ts      # DEX programs, token mints, Jito accounts
│   ├── utils.ts          # Shared helpers
│   ├── mev-engine.ts     # Whale detection + triangular arb
│   └── arb-engine.ts     # Prediction market scanner + execution
├── .env.example          # Template for your config
├── ecosystem.config.js   # PM2 process manager config
├── package.json          # Dependencies + scripts
├── tsconfig.json         # TypeScript config for Node
├── setup.sh              # One-command setup script
└── README.md             # This file
```

## PM2 Commands

```bash
pm2 start ecosystem.config.js   # Start both engines
pm2 logs                        # View all logs
pm2 logs ricky-mev              # MEV logs only
pm2 logs ricky-arb              # Arb logs only
pm2 status                      # Process status
pm2 restart all                 # Restart everything
pm2 stop all                    # Stop everything
pm2 save && pm2 startup         # Auto-start on reboot
```

## Safety

- **Profit check guardrail**: Tx reverts if `final_USDC < start + tip + $0.05` — reverted = $0 cost
- **Rate limit protection**: Exponential backoff on both Helius RPC and DFlow endpoints
- **Queue management**: Capped at 500 pending signatures to prevent memory issues
- **Graceful degradation**: Individual DEX subscription failures don't crash the engine
