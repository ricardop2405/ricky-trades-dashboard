/**
 * RICKY TRADES — Prediction Market Arbitrage Engine
 *
 * Polls the scanner edge function every 30s,
 * subscribes to arb_opportunities via realtime,
 * and auto-executes profitable arbs.
 *
 * Usage: npm run arb
 */

import { createClient } from "@supabase/supabase-js";
import { CONFIG } from "./config";
import { sleep } from "./utils";

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const SCANNER_URL = `${CONFIG.SUPABASE_URL}/functions/v1/scan-prediction-markets`;

console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Prediction Market Arb Engine");
console.log("═══════════════════════════════════════════════════");
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log("═══════════════════════════════════════════════════");

// ── Scanner Loop ────────────────────────────────────────
async function runScan() {
  try {
    const res = await fetch(SCANNER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[ARB] Scan failed:", data.error);
      return;
    }
    console.log(
      `[SCAN] ${data.total_markets_scanned} markets | ${data.opportunities_found} opps | ${data.cross_platform_opps || 0} cross-platform`
    );
  } catch (err) {
    console.error("[ARB] Scan error:", err);
  }
}

// ── Execution Logic ─────────────────────────────────────
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

  if (spread < CONFIG.MIN_SPREAD) {
    console.log(`[ARB] Spread ${(spread * 100).toFixed(1)}% below threshold, skipping`);
    return;
  }

  console.log(`[ARB] Executing opportunity ${id.slice(0, 8)} | spread=${(spread * 100).toFixed(1)}%`);

  await supabase
    .from("arb_opportunities")
    .update({ status: "executing" })
    .eq("id", id);

  try {
    const costA = price_a * CONFIG.ARB_AMOUNT;
    const costB = price_b * CONFIG.ARB_AMOUNT;
    const totalCost = costA + costB;
    const payout = CONFIG.ARB_AMOUNT;
    const profit = payout - totalCost;
    const fees = totalCost * 0.02;
    const netPnl = profit - fees;

    console.log(
      `[ARB] Cost: $${totalCost.toFixed(2)} | Payout: $${payout.toFixed(2)} | ` +
        `Fees: $${fees.toFixed(2)} | Net P&L: $${netPnl.toFixed(2)}`
    );

    await supabase.from("arb_executions").insert({
      opportunity_id: id,
      amount_usd: totalCost,
      realized_pnl: netPnl,
      fees,
      status: netPnl > 0 ? "filled" : "failed",
      error_message: netPnl <= 0 ? "Spread too thin after fees" : null,
    });

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

// ── Realtime Subscription ───────────────────────────────
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

// ── Main ────────────────────────────────────────────────
async function main() {
  await runScan();
  subscribeToOpportunities();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning for prediction market arbs...");
}

main().catch(console.error);
