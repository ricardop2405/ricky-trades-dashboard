

# Atomic Solana Triangular Arb — Full Production Upgrade

## What We're Building

Upgrade `mev-engine.ts` from simulation-only to **real atomic execution** using Jito bundles. The bot watches whale swaps on 8 DEXes via WebSocket, finds triangular arb routes (USDC → SOL → Token → USDC), and submits them as atomic Jito bundles. **Profit or full revert — zero cost on failure.**

## Best Setup Recommendations

| Decision | Recommendation | Why |
|----------|---------------|-----|
| **RPC** | **Helius** (paid plan, $50/mo) | Fastest WebSocket + getParsedTransaction, free tier rate-limits hard |
| **Swap Router** | **Jupiter V6 API** | Best aggregator, routes across all DEXes, gives serialized swap txs |
| **Bundle Submission** | **Jito Block Engine** | Atomic bundles, tip-only-on-success, ~95% block inclusion on Solana |
| **Scan Frequency** | **Real-time** (WebSocket `onLogs`) + **250ms queue drain** | As fast as possible — arbs are gone in <1 second |
| **Entry Size** | **$10-50 USDC** (configurable) | Matches your budget; scales up as profits grow |
| **Intermediate Tokens** | SOL, RAY, JUP, JTO, BONK, WIF, jitoSOL | High-liquidity pairs = tighter quotes = more arb windows |

## Profitability Math & Safety

```text
Entry: $50 USDC
Route: USDC → SOL → BONK → USDC

Leg 1 quote: $50 USDC → 0.333 SOL (Jupiter, 0.5% slippage max)
Leg 2 quote: 0.333 SOL → 1,234,567 BONK (Raydium, 0.5% slippage max)  
Leg 3 quote: 1,234,567 BONK → $50.35 USDC (Orca, 0.5% slippage max)

Gross profit:     $0.35
Jito tip:        -$0.001 (10,000 lamports ≈ $0.0015)
Net profit:       $0.349

SAFETY: On-chain check in the bundle:
  IF final_usdc < entry_usdc + jito_tip_in_usdc
  THEN entire bundle reverts → you pay $0.00
```

**Risks handled:**
- **Slippage**: Jupiter quotes include worst-case slippage; bundle reverts if actual output is worse
- **Rugpull tokens**: Only route through known high-liquidity tokens (SOL, RAY, JUP, etc.) — no random memecoins
- **Jito tip wasted**: Tip is INSIDE the bundle — only paid if all legs succeed
- **Stale quotes**: Quotes expire in ~30s; we build and submit within 2s of detection
- **Front-running our own arb**: Jito bundles are private — not visible in the public mempool

## Changes

### 1. Add missing MEV config to `config.ts`

Add all fields the engine references but are currently missing:
- `HELIUS_WS` — WebSocket endpoint (required for `onLogs`)
- `WHALE_THRESHOLD` — minimum swap size to trigger arb check ($5,000)
- `JITO_TIP` — tip in lamports (10,000 = ~$0.0015)
- `MIN_PROFIT` — minimum net profit to execute ($0.10)
- `MEV_ENTRY_USDC` — entry amount in USDC raw units (default $50)
- `MEV_DRY_RUN` — safety toggle, default `true`
- `MAX_PENDING_SIGNATURES`, `PARSED_TX_MIN_INTERVAL_MS`, `MAX_GET_TX_RETRIES`, `RATE_LIMIT_BACKOFF_MS`
- `JITO_BLOCK_ENGINE_URL` — bundle submission endpoint

### 2. Rewrite `executeBackrun` in `mev-engine.ts`

Replace simulation with real execution:

1. **Check USDC balance** before attempting
2. **Multi-route scan**: try 7 intermediate tokens (SOL, RAY, JUP, JTO, BONK, WIF, jitoSOL), pick best profit
3. **Get serialized swap transactions** from Jupiter `/swap` endpoint (not just `/quote`)
4. **Build atomic bundle**: combine all swap instructions + Jito tip into one `VersionedTransaction`
5. **On-chain profit guard**: add instruction that reverts if `final_usdc < start_usdc + tip`
6. **Submit to Jito Block Engine** via `sendBundle` API
7. **Poll confirmation** and log result to Supabase
8. If `MEV_DRY_RUN=true`, log everything but skip submission

### 3. Add token whitelist for safety

Only allow routing through known high-liquidity tokens to avoid rugpull/low-liquidity traps. Configurable list in constants.

### 4. Update `.env.example`

Document all new MEV env vars with sensible defaults.

### 5. Update `ecosystem.config.js`

The `ricky-mev` entry already exists — no changes needed.

## Files Changed

| File | What |
|------|------|
| `bot/production/src/config.ts` | Add ~15 missing MEV config fields |
| `bot/production/src/mev-engine.ts` | Full rewrite of `executeBackrun` + multi-route scanning + Jito bundle submission + balance checks |
| `bot/production/src/constants.ts` | Add `ARB_INTERMEDIATE_TOKENS` whitelist |
| `bot/production/.env.example` | Add MEV section with all new env vars |

## What You Need to Provide

1. **Helius API key** — sign up at helius.dev (free tier works to start, paid for speed)
2. **Solana wallet private key** — the wallet holding your USDC
3. Fund wallet with **$10-50 USDC** + **~0.01 SOL** for rent

