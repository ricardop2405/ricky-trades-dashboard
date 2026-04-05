

# Cross-Prediction-Market Arbitrage Scanner & Auto-Executor

## The Strategy

Prediction markets price YES/NO outcomes. If Polymarket prices "Trump wins" YES at $0.62 and another platform prices NO at $0.35, buying both costs $0.97 — one MUST pay $1.00, netting $0.03 guaranteed profit per share.

The bot scans for these mispricings across platforms and auto-executes.

## Reality Check: Atomicity

True atomic execution (all-or-nothing) is only possible on the **same chain**. Cross-platform trades across different chains (e.g., Polymarket on Polygon vs Drift on Solana) cannot be atomic — prices can move between your two orders. We can minimize this with near-simultaneous execution.

**Same-chain atomic options:**
- Polymarket internal (YES + NO on same market if mispriced vs $1)
- Multiple Polymarket markets on same event

**Cross-platform (near-simultaneous, not atomic):**
- Polymarket (Polygon) + Drift BET (Solana)

## What We'll Build

### 1. Edge Function: Prediction Market Scanner
Polls prediction market APIs every 30s, matches events across platforms, calculates arbitrage spread.

**APIs to integrate:**
- **Polymarket** — public CLOB API (no key needed), Polygon chain
- **Drift BET** — Solana-based, uses Drift protocol API

### 2. New Database Tables
- `prediction_markets` — cached market data from each platform
- `arb_opportunities` — detected mispricings with spread, confidence, status
- `arb_executions` — execution results (placed orders, fills, P&L)

### 3. Dashboard Page
New `/arbitrage` page showing:
- Live arb opportunities ranked by spread
- Execution history with P&L
- Platform connection status

### 4. Execution Engine (VPS bot addition)
New `bot/arb-engine.ts` that:
- Subscribes to arb_opportunities table via Supabase realtime
- Places near-simultaneous orders on both platforms
- Logs results to arb_executions

## Technical Details

**Polymarket API** (free, no auth):
- `GET https://clob.polymarket.com/markets` — list markets
- `GET https://clob.polymarket.com/prices?token_id=X` — get prices

**Drift BET API**:
- Uses Drift SDK on Solana (your existing Solana wallet works)

**Minimum viable arb**: Spread > 2% after fees (Polymarket ~2% fee, Drift ~0.1%)

**Your $50 budget**: Prediction market shares cost $0.01-$0.99 each, so you can buy many shares. A 3% arb on $50 split across both sides = ~$0.75 profit per opportunity. Much more viable than MEV with $50.

## Implementation Steps

1. Create database tables for markets, opportunities, executions
2. Build edge function to scan Polymarket API and find arb spreads
3. Add dashboard page with live arb opportunities
4. Build VPS execution engine for auto-trading
5. Connect to Drift BET for cross-platform scanning

