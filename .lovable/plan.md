

# Maximize the Dashboard for Live Trade Visibility

The bot is running and writing to `whale_trades` and `bundle_results` tables. The dashboard already has real-time subscriptions via Supabase. The goal is to upgrade the dashboard to show as much trade data as possible with better visualization and more information density.

## What we'll build

1. **Enable realtime on both tables** -- Add a migration to enable `supabase_realtime` publication for `whale_trades` and `bundle_results` so the existing realtime subscriptions actually work.

2. **Lower the display threshold** -- The bot filters at $50k on the VPS side, but the dashboard mempool feed highlights at $20k. We'll keep showing all trades that come in from the bot.

3. **Add a Top Tokens panel** -- New component showing which tokens are being traded most frequently and by volume, updated in real-time from the whale_trades data.

4. **Add a Whale Wallet Tracker** -- Show repeat wallets, how many times they've traded, and total volume. Helps identify smart money.

5. **Add a Live Trade Volume chart** -- Replace the static mock price chart with a real-time volume chart built from actual `whale_trades` data, showing trade volume over time.

6. **Add a 24h P&L Summary card** -- Show profit/loss over the last 24 hours from `bundle_results`, with a mini sparkline.

7. **Expand the stats bar** -- Add win streak, largest single profit, total trades monitored, and trades/hour metrics.

8. **Add trade detail drawer** -- Click any trade in the mempool feed or performance log to see full details including tx signature link to Solscan.

9. **Responsive layout improvements** -- Make the grid work better on the 654px viewport, stack panels vertically on smaller screens.

## Database changes

**Migration**: Enable realtime publication for both tables:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.whale_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bundle_results;
```

No new tables needed -- all new components derive from existing `whale_trades` and `bundle_results` data.

## Files to create/modify

| File | Action |
|------|--------|
| `supabase/migrations/enable_realtime.sql` | New -- enable realtime |
| `src/components/TopTokens.tsx` | New -- token frequency/volume panel |
| `src/components/WalletTracker.tsx` | New -- repeat whale wallet tracker |
| `src/components/VolumeChart.tsx` | New -- real-time volume over time |
| `src/components/TradeDetailDrawer.tsx` | New -- click-to-inspect trade details with Solscan links |
| `src/components/StatsBar.tsx` | Modify -- add more metrics |
| `src/components/MempoolFeed.tsx` | Modify -- add click handler for detail drawer |
| `src/components/PerformanceLog.tsx` | Modify -- add click handler for detail drawer |
| `src/components/PriceChart.tsx` | Replace with real volume chart |
| `src/hooks/useLiveData.ts` | Modify -- compute derived stats (top tokens, wallet tracking, volume buckets) |
| `src/pages/Index.tsx` | Modify -- new layout with all panels |
| `src/lib/mockData.ts` | Modify -- add types for new derived data |

## Layout (desktop)

```text
┌─────────────────────────────────────────────────────┐
│ RICKY TRADES COMMAND          Status Indicators     │
├─────────────────────────────────────────────────────┤
│ Stats: Profit | Bundles | Rate | Latency | Streak  │
├────────────┬──────────────────────┬─────────────────┤
│ MEMPOOL    │ VOLUME CHART         │ TOP TOKENS      │
│ FEED       │                      │                 │
│ (click     ├──────────────────────┤ WALLET TRACKER  │
│  to see    │ PERFORMANCE LOG      │                 │
│  details)  │                      │ CONTROLS        │
├────────────┴──────────────────────┴─────────────────┤
│ Trade Detail Drawer (slides up on click)            │
└─────────────────────────────────────────────────────┘
```

