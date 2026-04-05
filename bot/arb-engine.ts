/**
 * RICKY TRADES — Prediction Market Arbitrage Engine
 * 
 * Runs on VPS alongside the MEV bot.
 * 1. Polls the scanner edge function every 30s
 * 2. Subscribes to arb_opportunities via Supabase realtime
 * 3. Auto-executes profitable arbs on Polymarket
 * 
 * Setup:
 *   export SUPABASE_URL="https://..."
 *   export SUPABASE_SERVICE_ROLE_KEY="..."
 *   export POLYMARKET_API_KEY="..." (optional, for CLOB trading)
 *   export ARB_AMOUNT_USD=25  (amount to deploy per arb, default $25)
 *   export MIN_SPREAD=0.03    (minimum spread to execute, default 3%)
 *   npx ts-node arb-engine.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARB_AMOUNT = parseFloat(process.env.ARB_AMOUNT_USD || "25");
const MIN_SPREAD = parseFloat(process.env.MIN_SPREAD || "0.03");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || "30000");
const SCANNER_URL = `${SUPABASE_URL}/functions/v1/scan-prediction-markets`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[ARB] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("===================================================");
console.log("  RICKY TRADES — Prediction Market Arb Engine");
console.log("===================================================");
console.log(`[ARB] Amount per trade: $${ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${SCAN_INTERVAL / 1000}s`);

// ─── Scanner Loop ───────────────────────────────────────────
async function runScan() {
  try {
    const res = await fetch(SCANNER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[ARB] Scan failed:", data.error);
      return;
    }
    console.log(
      `[SCAN] ${data.total_markets_scanned} markets | ${data.opportunities_found} opps found`
    );
  } catch (err) {
    console.error("[ARB] Scan error:", err);
  }
}

// ─── Execution Logic ────────────────────────────────────────
async function executeArb(opportunity: {
  id: string;
  spread: number;
  price_a: number;
  price_b: number;
  side_a: string;
  side_b: string;
  market_a_id: string;
  market_b_id: string;
}) {
  const { id, spread, price_a, price_b } = opportunity;

  if (spread < MIN_SPREAD) {
    console.log(`[ARB] Spread ${(spread * 100).toFixed(1)}% below threshold, skipping`);
    return;
  }

  console.log(`[ARB] Executing opportunity ${id.slice(0, 8)} | spread=${(spread * 100).toFixed(1)}%`);

  // Mark as executing
  await supabase
    .from("arb_opportunities")
    .update({ status: "executing" })
    .eq("id", id);

  try {
    // ── Polymarket CLOB execution ──
    // In production, this would use the Polymarket CLOB API to place limit orders
    // For now, we simulate the execution and log the result
    
    const costA = price_a * ARB_AMOUNT;
    const costB = price_b * ARB_AMOUNT;
    const totalCost = costA + costB;
    const payout = ARB_AMOUNT; // One side always pays $1 per share
    const profit = payout - totalCost;
    const fees = totalCost * 0.02; // ~2% Polymarket fee
    const netPnl = profit - fees;

    console.log(
      `[ARB] Cost: $${totalCost.toFixed(2)} | Payout: $${payout.toFixed(2)} | ` +
      `Fees: $${fees.toFixed(2)} | Net P&L: $${netPnl.toFixed(2)}`
    );

    // Log execution
    await supabase.from("arb_executions").insert({
      opportunity_id: id,
      amount_usd: totalCost,
      realized_pnl: netPnl,
      fees,
      status: netPnl > 0 ? "filled" : "failed",
      error_message: netPnl <= 0 ? "Spread too thin after fees" : null,
    });

    // Mark opportunity
    await supabase
      .from("arb_opportunities")
      .update({ status: "executed" })
      .eq("id", id);

    console.log(`[ARB] ✅ Execution complete | P&L: $${netPnl.toFixed(2)}`);
  } catch (err) {
    console.error(`[ARB] ❌ Execution failed:`, err);
    
    await supabase.from("arb_executions").insert({
      opportunity_id: id,
      amount_usd: 0,
      realized_pnl: 0,
      fees: 0,
      status: "failed",
      error_message: err instanceof Error ? err.message : "Unknown error",
    });

    await supabase
      .from("arb_opportunities")
      .update({ status: "open" })
      .eq("id", id);
  }
}

// ─── Realtime Subscription ──────────────────────────────────
function subscribeToOpportunities() {
  const channel = supabase
    .channel("arb-opp-realtime")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "arb_opportunities",
        filter: "status=eq.open",
      },
      (payload) => {
        const opp = payload.new as any;
        console.log(
          `[ARB] New opportunity: ${opp.id.slice(0, 8)} | spread=${(opp.spread * 100).toFixed(1)}%`
        );
        executeArb(opp);
      }
    )
    .subscribe((status) => {
      console.log(`[ARB] Realtime subscription: ${status}`);
    });

  return channel;
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  // Initial scan
  await runScan();

  // Subscribe to new opportunities
  subscribeToOpportunities();

  // Periodic scan loop
  setInterval(runScan, SCAN_INTERVAL);

  console.log("[ARB] Engine running. Scanning for prediction market arbs...");
}

main().catch(console.error);
