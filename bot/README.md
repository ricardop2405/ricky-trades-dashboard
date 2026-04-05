# Ricky Trades Command — MEV Bot Deployment

## Architecture

```
VPS (Railway/Fly.io)          Supabase (Cloud)           Dashboard (Lovable)
┌──────────────────┐         ┌─────────────────┐        ┌──────────────────┐
│ bot/engine.ts    │─writes─▶│ whale_trades     │◀─reads─│ Live Mempool     │
│ WebSocket → RPC  │         │ bundle_results   │        │ Performance Log  │
│ Jupiter V6 scan  │         └─────────────────┘        │ Stats + Charts   │
│ Jito bundles     │                                     └──────────────────┘
└──────────────────┘
```

## Quick Start

```bash
# On your VPS
cp -r bot/ ~/ricky-bot && cd ~/ricky-bot
npm init -y
npm install @solana/web3.js @supabase/supabase-js bs58 typescript ts-node

# Set environment variables
export SOLANA_PRIVATE_KEY="<base58>"
export HELIUS_RPC_URL="wss://mainnet.helius-rpc.com/?api-key=KEY"
export HELIUS_HTTP_URL="https://mainnet.helius-rpc.com/?api-key=KEY"
export SUPABASE_URL="<url>"
export SUPABASE_SERVICE_ROLE_KEY="<key>"
export JITO_TIP_LAMPORTS=5000000
export MIN_PROFIT_USD=0.05

# Run
npx ts-node engine.ts
```

## Profit Check Guardrail

Two layers:
1. **Pre-flight**: Bot skips if estimated profit < MIN_PROFIT_USD
2. **On-chain**: Tx instruction checks `final_USDC > start_USDC + tip + $0.05` — reverts entire atomic bundle if false ($0 cost)

## Triangular Arb Route

```
USDC ──► SOL ──► TargetToken ──► USDC
```
Three Jupiter V6 swaps in one atomic Jito bundle.
