# Ricky Trades Command — MEV Bot Deployment Guide

## Architecture

```
┌─────────────────────────────────────┐
│  VPS (Railway / Fly.io / EC2)       │
│  ┌───────────────────────────────┐  │
│  │  MEV Bot Engine (Node.js)     │  │
│  │  - WebSocket → Helius RPC     │  │
│  │  - Jupiter V6 monitoring      │  │
│  │  - Triangular arb calculator  │  │
│  │  - Jito bundle submission     │  │
│  │  - Profit check guardrail     │  │
│  └──────────┬────────────────────┘  │
│             │ writes                │
└─────────────┼───────────────────────┘
              ▼
┌─────────────────────────────────────┐
│  Supabase (Lovable Cloud)           │
│  - whale_trades table               │
│  - bundle_results table             │
│  - Real-time subscriptions          │
└──────────┬──────────────────────────┘
           │ reads (real-time)
           ▼
┌─────────────────────────────────────┐
│  Dashboard (Lovable Web App)        │
│  - Live mempool feed                │
│  - Performance log                  │
│  - Stats & price charts             │
│  - Controls                         │
└─────────────────────────────────────┘
```

## Setup

### 1. Environment Variables (VPS)

```env
SOLANA_PRIVATE_KEY=<base58 encoded private key>
HELIUS_RPC_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_HTTP_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SUPABASE_URL=<your Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
JITO_TIP_LAMPORTS=5000000
MIN_PROFIT_USD=0.05
```

### 2. Install Dependencies

```bash
npm install @solana/web3.js @supabase/supabase-js bs58 typescript ts-node
# For Jito bundle submission:
npm install jito-ts
```

### 3. Run

```bash
npx ts-node bot/engine.ts
```

### 4. Deploy on Railway

```bash
railway init
railway up
```

## How the Profit Check Works

The bot implements a safety guardrail at TWO levels:

1. **Pre-flight check** (in the bot): If estimated profit < MIN_PROFIT_USD, the bundle is never submitted.

2. **On-chain check** (in the transaction): A custom instruction verifies:
   ```
   final_USDC_balance > initial_USDC_balance + jito_tip_in_USDC + $0.05
   ```
   If this check fails, the ENTIRE atomic Jito bundle reverts.
   Reverted bundles cost $0 (Jito's atomic execution guarantee).

## Triangular Arbitrage Route

```
USDC ──[Leg 1]──► SOL ──[Leg 2]──► TargetToken ──[Leg 3]──► USDC
       Jupiter          Jupiter              Jupiter
```

The bot detects what token the whale is buying, then races to:
1. Convert USDC → SOL
2. Convert SOL → the target token (riding the whale's price impact)
3. Convert the target token back → USDC at a profit
