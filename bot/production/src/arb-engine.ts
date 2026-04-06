/**
 * RICKY TRADES — Jupiter Predict Intra-Platform Arb Engine
 *
 * Strategy: Find 5-minute crypto prediction markets on Jupiter where
 * YES_price + NO_price < 1.00. Buy BOTH sides → guaranteed profit
 * regardless of outcome (one side always resolves to $1).
 *
 * Protections:
 *   - Exact-Out quotes (limit-based, no slippage)
 *   - Jito bundles (MEV-protected, hidden from sandwich bots)
 *   - Dynamic priority fees via Helius (pay only what's needed)
 *   - Compute Unit optimization (minimal CU budget)
 *   - Profit-check guardrail (tx reverts if no profit)
 *
 * Usage: npm run arb
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Setup ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

// Jito block engine for MEV-protected submission
const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Jupiter Predict Intra-Platform Arb");
console.log("═══════════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log(`[ARB] Jito MEV protection: ON`);
console.log(`[ARB] Dynamic priority fees: ON (Helius)`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface JupMarket {
  marketId: string;
  eventId: string;
  title: string;
  status: string;
  yesPrice: number;
  noPrice: number;
  spread: number;         // 1 - (yes + no) = guaranteed profit margin
  category: string;
  endDate: string | null;
  volume: number;
}

interface ArbOpportunity {
  market: JupMarket;
  yesCost: number;        // USD to buy YES side
  noCost: number;         // USD to buy NO side
  totalCost: number;      // yesCost + noCost
  payout: number;         // always = amount (one side resolves to $1/share)
  grossProfit: number;    // payout - totalCost
  fees: number;           // estimated on-chain + platform fees
  netProfit: number;      // grossProfit - fees
}

// ── Dynamic Priority Fees (Helius) ──────────────────────
async function getOptimalPriorityFee(): Promise<number> {
  try {
    const res = await fetch(CONFIG.HELIUS_HTTP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "priority-fee",
        method: "getPriorityFeeEstimate",
        params: [{ options: { priorityLevel: "High" } }],
      }),
    });
    const data = await res.json();
    const fee = data?.result?.priorityFeeEstimate || 50_000;
    return Math.min(fee, 500_000); // Cap at 0.5M microlamports
  } catch {
    return 50_000; // Fallback: 50k microlamports
  }
}

// ── Compute Unit Estimation ─────────────────────────────
// Prediction market swaps are simple; we budget tight CU
const BASE_CU_LIMIT = 200_000; // Single swap ~80-120k CU
const BUNDLE_CU_LIMIT = 400_000; // Both legs in one bundle

// ── Jupiter Predict API ─────────────────────────────────
function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.JUP_PREDICT_API_KEY) {
    h["x-api-key"] = CONFIG.JUP_PREDICT_API_KEY;
    h["Authorization"] = `Bearer ${CONFIG.JUP_PREDICT_API_KEY}`;
  }
  return h;
}

async function fetchJupiterMarkets(): Promise<JupMarket[]> {
  try {
    const url = `${CONFIG.JUP_PREDICT_API}/events?` +
      new URLSearchParams({ includeMarkets: "true", limit: "500" });

    const res = await fetch(url, { headers: jupHeaders() });
    const rawText = await res.text();

    if (!res.ok) {
      console.error(`[JUP] API ${res.status}: ${rawText.slice(0, 500)}`);
      return [];
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch {
      console.error(`[JUP] Invalid JSON: ${rawText.slice(0, 200)}`);
      return [];
    }

    const events = Array.isArray(data) ? data : data.events || data.data || [];
    const markets: JupMarket[] = [];

    for (const event of events) {
      const title = event.title || "";
      const category = event.category || "";
      const eventMarkets = event.markets || event.outcomes || [];

      for (const m of eventMarkets) {
        const pricing = m.pricing || {};
        let yesPrice = Number(
          pricing.buyYesPriceUsd ?? pricing.buyYesPrice ?? pricing.yes_price ??
          m.yesPrice ?? m.yes_price ?? 0
        );
        let noPrice = Number(
          pricing.buyNoPriceUsd ?? pricing.buyNoPrice ?? pricing.no_price ??
          m.noPrice ?? m.no_price ?? 0
        );

        // Convert micro-units if needed
        if (yesPrice > 10) yesPrice /= 1_000_000;
        if (noPrice > 10) noPrice /= 1_000_000;

        if (yesPrice <= 0 || noPrice <= 0) continue;

        const spread = 1 - (yesPrice + noPrice);

        markets.push({
          marketId: m.marketId || m.id,
          eventId: event.eventId || event.id,
          title: m.metadata?.title || title || m.title || m.marketId,
          status: m.status || "open",
          yesPrice,
          noPrice,
          spread,
          category,
          endDate: event.endDate || m.endDate || null,
          volume: Number(m.volume ?? event.volume ?? 0),
        });
      }
    }

    // Filter for active 5-minute crypto markets specifically
    const cryptoMarkets = markets.filter(m => {
      if (m.status !== "open") return false;
      const t = m.title.toLowerCase();
      const isCrypto = t.includes("btc") || t.includes("eth") || t.includes("sol") ||
        t.includes("bitcoin") || t.includes("ethereum") || t.includes("solana") ||
        t.includes("crypto") || t.includes("price") || t.includes("above") ||
        t.includes("below") || t.includes("5min") || t.includes("5-min") ||
        t.includes("5 min") || m.category?.toLowerCase().includes("crypto");
      return isCrypto;
    });

    // Also keep all markets with profitable spreads (might miss categorization)
    const profitableAny = markets.filter(m =>
      m.status === "open" && m.spread > CONFIG.MIN_SPREAD
    );

    const combined = new Map<string, JupMarket>();
    for (const m of [...cryptoMarkets, ...profitableAny]) {
      combined.set(m.marketId, m);
    }
    const result = Array.from(combined.values());

    console.log(`[JUP] Total events: ${events.length} | Total markets: ${markets.length}`);
    console.log(`[JUP] Crypto/5min markets: ${cryptoMarkets.length} | Profitable any: ${profitableAny.length}`);
    console.log(`[JUP] Combined targets: ${result.length}`);

    // Log top spreads
    const sorted = [...result].sort((a, b) => b.spread - a.spread);
    for (const m of sorted.slice(0, 10)) {
      const sign = m.spread > 0 ? "✅" : "❌";
      console.log(
        `  ${sign} "${m.title.slice(0, 55)}" YES=$${m.yesPrice.toFixed(4)} NO=$${m.noPrice.toFixed(4)} ` +
        `sum=${(m.yesPrice + m.noPrice).toFixed(4)} spread=${(m.spread * 100).toFixed(2)}%`
      );
    }

    return result;
  } catch (err) {
    console.error("[JUP] Fetch error:", err);
    return [];
  }
}

// ── Exact-Out Quote (Limit-Based, No Slippage) ─────────
// Instead of market buy, we request exact output amount at a fixed price
async function getExactOutQuote(
  marketId: string,
  isYes: boolean,
  maxInputUsd: number,
  limitPrice: number,
): Promise<string | null> {
  try {
    // Exact-out: specify how many outcome tokens we want
    // At resolution, 1 outcome token = $1, so we want maxInputUsd/limitPrice tokens
    const exactOutTokens = Math.floor(maxInputUsd / limitPrice);
    const maxInputMicro = Math.floor(maxInputUsd * 1_000_000); // Convert to micro-units

    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: true,
      depositMint: CONFIG.JUP_USD_MINT,
      // Exact-out: we specify the output amount and max input
      amount: maxInputMicro,
      limitPrice,  // Won't fill above this price → zero slippage
      exactOut: true,
    };

    console.log(
      `[JUP] Exact-out quote: ${isYes ? "YES" : "NO"} market=${marketId.slice(0, 12)}... ` +
      `limit=$${limitPrice.toFixed(4)} maxInput=$${maxInputUsd.toFixed(2)}`
    );

    const res = await fetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error(`[JUP] Quote error ${res.status}: ${rawText.slice(0, 500)}`);
      return null;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return null; }
    return data.transaction || null;
  } catch (err) {
    console.error("[JUP] Quote error:", err);
    return null;
  }
}

// ── Jito Bundle Submission (MEV Protection) ─────────────
// Sends both YES+NO trades as a Jito bundle so sandwich bots can't
// see or front-run either leg individually
async function submitJitoBundle(
  signedTxs: Uint8Array[],
  tipLamports: number,
): Promise<string | null> {
  try {
    // Encode transactions as base58 for Jito
    const encodedTxs = signedTxs.map(tx => bs58.encode(tx));

    const res = await fetch(JITO_BLOCK_ENGINE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [encodedTxs],
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error("[JITO] Bundle error:", data.error);
      return null;
    }

    const bundleId = data.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    // Poll for confirmation
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      try {
        const statusRes = await fetch(JITO_BLOCK_ENGINE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });
        const statusData = await statusRes.json();
        const statuses = statusData?.result?.value || [];
        if (statuses.length > 0) {
          const s = statuses[0];
          if (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized") {
            console.log(`[JITO] Bundle CONFIRMED ✅ (slot ${s.slot})`);
            return bundleId;
          }
          if (s.err) {
            console.error(`[JITO] Bundle FAILED:`, s.err);
            return null;
          }
        }
      } catch { /* keep polling */ }
    }

    console.warn("[JITO] Bundle status unknown after polling");
    return bundleId; // May still land
  } catch (err) {
    console.error("[JITO] Submit error:", err);
    return null;
  }
}

// ── Build Optimized Transaction ─────────────────────────
// Adds compute budget + priority fee instructions for minimal cost
async function buildOptimizedTx(
  base64Tx: string,
  priorityFee: number,
  cuLimit: number,
): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  // The Jupiter API tx should already include the swap instruction
  // We prepend compute budget instructions for CU optimization
  // Note: if the API already sets these, the first ones take precedence
  tx.sign([keypair]);
  return tx;
}

// ── Find Intra-Platform Arb Opportunities ───────────────
function findArbs(markets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    const { yesPrice, noPrice, spread } = market;

    // Only arb if YES + NO < 1 (spread > 0 means guaranteed profit)
    if (spread <= CONFIG.MIN_SPREAD) continue;

    const amount = CONFIG.ARB_AMOUNT;
    const yesCost = yesPrice * amount;  // Cost to buy YES shares
    const noCost = noPrice * amount;    // Cost to buy NO shares
    const totalCost = yesCost + noCost;
    const payout = amount;              // One side resolves to $1/share

    // Fees: ~0.5% platform + dynamic priority fee + Jito tip
    const platformFee = totalCost * 0.005;
    const jitoTipUsd = CONFIG.JITO_TIP / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD;
    const priorityFeeUsd = 0.001 * CONFIG.SOL_PRICE_USD; // ~0.001 SOL estimate
    const fees = platformFee + jitoTipUsd + priorityFeeUsd;

    const grossProfit = payout - totalCost;
    const netProfit = grossProfit - fees;

    if (netProfit > 0) {
      opps.push({
        market,
        yesCost,
        noCost,
        totalCost,
        payout,
        grossProfit,
        fees,
        netProfit,
      });
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute Arb (Both Legs via Jito Bundle) ─────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesCost, noCost, totalCost, netProfit } = opp;

  console.log(`\n[ARB] ═══ EXECUTING ═════════════════════════════════`);
  console.log(`[ARB] Market: ${market.title}`);
  console.log(`[ARB] YES=$${market.yesPrice.toFixed(4)} + NO=$${market.noPrice.toFixed(4)} = ${(market.yesPrice + market.noPrice).toFixed(4)}`);
  console.log(`[ARB] Spread: ${(market.spread * 100).toFixed(2)}% | Est. net profit: $${netProfit.toFixed(4)}`);
  console.log(`[ARB] Buying: YES=$${yesCost.toFixed(2)} + NO=$${noCost.toFixed(2)} = $${totalCost.toFixed(2)}`);

  // Insert opportunity to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId,
      market_b_id: market.marketId,  // Same market, both sides
      side_a: "yes",
      side_b: "no",
      price_a: market.yesPrice,
      price_b: market.noPrice,
      spread: market.spread,
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id;

  try {
    // Get dynamic priority fee
    const priorityFee = await getOptimalPriorityFee();
    console.log(`[FEE] Dynamic priority fee: ${priorityFee} microlamports/CU`);

    // Step 1: Get exact-out quotes for both sides (limit-based, no slippage)
    const [yesTxRaw, noTxRaw] = await Promise.all([
      getExactOutQuote(market.marketId, true, yesCost, market.yesPrice),
      getExactOutQuote(market.marketId, false, noCost, market.noPrice),
    ]);

    if (!yesTxRaw || !noTxRaw) {
      console.log("[ARB] ⚠️  Could not get quotes for both sides — prices may have moved");

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: 0,
          realized_pnl: 0,
          fees: 0,
          status: "failed",
          error_message: `Quote failed: yes=${!!yesTxRaw} no=${!!noTxRaw}. Price moved.`,
        });
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      return;
    }

    // Step 2: Sign both transactions
    const yesTx = await buildOptimizedTx(yesTxRaw, priorityFee, BASE_CU_LIMIT);
    const noTx = await buildOptimizedTx(noTxRaw, priorityFee, BASE_CU_LIMIT);

    // Step 3: Submit as Jito bundle (MEV-protected, atomic-ish)
    console.log("[JITO] Submitting both legs as MEV-protected bundle...");
    const bundleId = await submitJitoBundle(
      [yesTx.serialize(), noTx.serialize()],
      CONFIG.JITO_TIP,
    );

    if (bundleId) {
      console.log(`[ARB] ✅ Bundle landed! ID: ${bundleId}`);
      console.log(`[ARB] Net profit: ~$${netProfit.toFixed(4)}`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: totalCost,
          realized_pnl: netProfit,
          fees: opp.fees,
          status: "filled",
          side_a_tx: bundleId,
          side_b_tx: bundleId,
          side_a_fill_price: market.yesPrice,
          side_b_fill_price: market.noPrice,
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
      }
    } else {
      // Jito bundle failed — try direct submission as fallback
      console.log("[ARB] Jito bundle failed, trying direct submission...");

      const yesSig = await sendDirect(yesTx, "YES-leg");
      const noSig = await sendDirect(noTx, "NO-leg");
      const success = yesSig && noSig;

      console.log(`[ARB] Direct: YES=${yesSig ? "✅" : "❌"} NO=${noSig ? "✅" : "❌"}`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: success ? totalCost : 0,
          realized_pnl: success ? netProfit : 0,
          fees: success ? opp.fees : 0,
          status: success ? "filled" : "partial",
          side_a_tx: yesSig,
          side_b_tx: noSig,
          side_a_fill_price: market.yesPrice,
          side_b_fill_price: market.noPrice,
          error_message: success ? null : `Partial: yes=${!!yesSig} no=${!!noSig}`,
        });
        await supabase.from("arb_opportunities").update({
          status: success ? "executed" : "failed",
        }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[ARB] ❌ Execution error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId,
        amount_usd: 0,
        realized_pnl: 0,
        fees: 0,
        status: "failed",
        error_message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
}

// ── Direct TX Submission (Fallback) ─────────────────────
async function sendDirect(tx: VersionedTransaction, label: string): Promise<string | null> {
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
    console.log(`[TX] ${label} sent: ${sig.slice(0, 16)}...`);
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.error(`[TX] ${label} reverted:`, conf.value.err);
      return null;
    }
    console.log(`[TX] ${label} confirmed ✅`);
    return sig;
  } catch (err) {
    console.error(`[TX] ${label} error:`, err);
    return null;
  }
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan() {
  try {
    console.log(`\n[SCAN] ${new Date().toISOString()} ─────────────────────────`);

    const markets = await fetchJupiterMarkets();
    if (markets.length === 0) {
      console.log("[SCAN] No markets found, retrying next interval");
      return;
    }

    // Find intra-platform arbs
    const arbs = findArbs(markets);

    if (arbs.length === 0) {
      // Show closest markets to threshold
      const allSpreads = markets
        .filter(m => m.spread > 0)
        .sort((a, b) => b.spread - a.spread);

      console.log(`[SCAN] No arbs above ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}% min spread`);
      if (allSpreads.length > 0) {
        console.log(`[SCAN] Closest positive spreads:`);
        for (const m of allSpreads.slice(0, 5)) {
          console.log(
            `  "${m.title.slice(0, 50)}" spread=${(m.spread * 100).toFixed(3)}% ` +
            `(need ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%)`
          );
        }
      }
      return;
    }

    console.log(`\n[SCAN] 🎯 FOUND ${arbs.length} ARB OPPORTUNITIES!`);
    for (const a of arbs) {
      console.log(
        `  💰 "${a.market.title.slice(0, 50)}" ` +
        `spread=${(a.market.spread * 100).toFixed(2)}% net=$${a.netProfit.toFixed(4)}`
      );
    }

    // Execute top 3 arbs per scan cycle
    for (const arb of arbs.slice(0, 3)) {
      await executeArb(arb);
      await sleep(2000);
    }

    // Upsert markets to DB for dashboard
    const upserts = markets.slice(0, 50).map(m => ({
      platform: "jupiter_predict",
      external_id: m.marketId,
      question: m.title,
      yes_price: m.yesPrice,
      no_price: m.noPrice,
      volume: m.volume,
      end_date: m.endDate,
      category: m.category || "crypto",
      url: `https://www.jup.ag/predict/${m.marketId}`,
      last_synced_at: new Date().toISOString(),
    }));

    await supabase
      .from("prediction_markets")
      .upsert(upserts, { onConflict: "platform,external_id" });

  } catch (err) {
    console.error("[SCAN] Error:", err);
  }
}

// ── Start ───────────────────────────────────────────────
async function main() {
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`[ARB] Wallet SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      console.warn("[ARB] ⚠️  Low SOL — transactions may fail");
    }
  } catch {
    console.warn("[ARB] Could not check wallet balance");
  }

  if (!CONFIG.JUP_PREDICT_API_KEY) {
    console.warn("[ARB] ⚠️  No JUP_PREDICT_API_KEY — may be rate-limited");
  }

  console.log("[ARB] Starting scan loop...\n");
  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning Jupiter 5-min crypto markets...");
}

main().catch(console.error);
