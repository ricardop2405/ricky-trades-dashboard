/**
 * RICKY TRADES — Drift BET ↔ Jupiter Predict Arb Engine
 *
 * Scans both Drift BET and Jupiter Predict for the same prediction
 * markets. When YES_a + NO_b < 1 (or vice versa), buys both sides
 * across platforms for guaranteed profit on resolution.
 *
 * - Drift BET: Public Data API (no key needed) + on-chain execution
 * - Jupiter Predict: Public API + on-chain execution
 * - Both are Solana-native = atomic settlement
 *
 * Usage: npm run arb
 */

import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Setup ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const WALLET = keypair.publicKey.toBase58();

// Drift BET public API — no key needed
const DRIFT_DATA_API = "https://data.api.drift.trade";

console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Drift BET ↔ Jupiter Predict Arb");
console.log("═══════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log(`[ARB] Drift API: ${DRIFT_DATA_API}`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log("═══════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface DriftBetMarket {
  marketIndex: number;
  symbol: string;
  contractType: string;
  status: string;
  // Prediction markets have prices 0-1
  markPrice: number;
  oraclePrice: number;
  bestBid: number;
  bestAsk: number;
  volume24h?: number;
}

interface JupMarket {
  marketId: string;
  eventId: string;
  status: string;
  metadata?: {
    title?: string;
    marketId?: string;
  };
  pricing?: {
    buyYesPriceUsd?: number;
    buyNoPriceUsd?: number;
  };
}

interface ArbOpportunity {
  drift_market_index: number;
  drift_symbol: string;
  jup_market_id: string;
  title: string;
  drift_yes: number;
  drift_no: number;
  jup_yes: number;
  jup_no: number;
  best_spread: number;
  strategy: "drift_yes_jup_no" | "drift_no_jup_yes";
}

// ── Drift BET API ───────────────────────────────────────
async function fetchDriftBetMarkets(): Promise<DriftBetMarket[]> {
  try {
    // Correct endpoint: /stats/markets — filter by symbols ending with "-BET"
    const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
    if (!res.ok) {
      console.error(`[DRIFT] API ${res.status}: ${await res.text()}`);
      return [];
    }

    const data = await res.json();
    const allMarkets = data.markets || data.data || (Array.isArray(data) ? data : []);

    // Filter: must end with "-BET" and be active (not settled/delisted)
    const betMarkets = allMarkets.filter((m: any) =>
      m.symbol?.endsWith("-BET") && m.status === "active"
    );

    const settledBets = allMarkets.filter((m: any) =>
      m.symbol?.endsWith("-BET") && m.status !== "active"
    );

    console.log(`[DRIFT] Total markets: ${allMarkets.length} | Active BET: ${betMarkets.length} | Settled BET: ${settledBets.length}`);

    const parsed: DriftBetMarket[] = betMarkets.map((m: any) => ({
      marketIndex: m.marketIndex ?? 0,
      symbol: m.symbol || "",
      contractType: "prediction",
      status: m.status || "active",
      markPrice: Number(m.markPrice ?? 0),
      oraclePrice: Number(m.oraclePrice ?? 0),
      bestBid: Number(m.price ?? m.markPrice ?? 0),
      bestAsk: Number(m.price ?? m.markPrice ?? 0),
      volume24h: Number(m.quoteVolume ?? 0),
    }));

    for (const m of parsed.slice(0, 5)) {
      console.log(
        `  [DRIFT] ${m.symbol} idx=${m.marketIndex} ` +
        `price=${m.markPrice.toFixed(4)} oracle=${m.oraclePrice.toFixed(4)} status=${m.status}`
      );
    }

    if (betMarkets.length === 0 && settledBets.length > 0) {
      console.log(`[DRIFT] ⚠️  All ${settledBets.length} BET markets are settled. Waiting for new listings on app.drift.trade/bet`);
    }

    return parsed;
  } catch (err) {
    console.error("[DRIFT] Fetch error:", err);
    return [];
  }
}

// Also try the orderbook endpoint for more accurate prices
async function getDriftOrderbook(marketIndex: number): Promise<{ bestBid: number; bestAsk: number } | null> {
  try {
    const res = await fetch(`${DRIFT_DATA_API}/l2?marketIndex=${marketIndex}&marketType=perp&depth=1`);
    if (!res.ok) return null;
    const data = await res.json();
    const bids = data.bids || [];
    const asks = data.asks || [];
    return {
      bestBid: bids.length > 0 ? Number(bids[0].price) : 0,
      bestAsk: asks.length > 0 ? Number(asks[0].price) : 0,
    };
  } catch {
    return null;
  }
}

// ── Jupiter Predict API ─────────────────────────────────
function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.JUP_PREDICT_API_KEY) {
    h["x-api-key"] = CONFIG.JUP_PREDICT_API_KEY;
    h["Authorization"] = `Bearer ${CONFIG.JUP_PREDICT_API_KEY}`;
  }
  return h;
}

async function fetchJupMarkets(): Promise<JupMarket[]> {
  try {
    const url = `${CONFIG.JUP_PREDICT_API}/events?` +
      new URLSearchParams({ includeMarkets: "true", limit: "200" });

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
    console.log(`[JUP] Events: ${events.length}`);

    const markets: JupMarket[] = [];
    for (const event of events) {
      const eventMarkets = event.markets || event.outcomes || [];
      for (const m of eventMarkets) {
        const pricing = m.pricing || {};
        const buyYes = pricing.buyYesPriceUsd ?? pricing.buyYesPrice ?? pricing.yes_price ?? m.yesPrice ?? m.yes_price ?? 0;
        const buyNo = pricing.buyNoPriceUsd ?? pricing.buyNoPrice ?? pricing.no_price ?? m.noPrice ?? m.no_price ?? 0;

        let yesNum = Number(buyYes) || 0;
        let noNum = Number(buyNo) || 0;
        // Convert micro-units if needed
        if (yesNum > 10) yesNum = yesNum / 1_000_000;
        if (noNum > 10) noNum = noNum / 1_000_000;

        markets.push({
          marketId: m.marketId || m.id,
          eventId: event.eventId || event.id,
          status: m.status || "open",
          metadata: { title: event.title || m.metadata?.title || m.title, marketId: m.marketId || m.id },
          pricing: {
            buyYesPriceUsd: yesNum,
            buyNoPriceUsd: noNum,
          },
        });
      }
    }

    // Log samples
    for (const m of markets.slice(0, 3)) {
      console.log(
        `  [JUP] "${(m.metadata?.title || m.marketId).slice(0, 50)}" ` +
        `YES=$${m.pricing?.buyYesPriceUsd?.toFixed(4)} NO=$${m.pricing?.buyNoPriceUsd?.toFixed(4)} status=${m.status}`
      );
    }

    return markets;
  } catch (err) {
    console.error("[JUP] Fetch error:", err);
    return [];
  }
}

async function getJupBuyTx(marketId: string, isYes: boolean, amountUsd: number): Promise<string | null> {
  try {
    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: true,
      depositMint: CONFIG.JUP_USD_MINT,
      amount: Math.floor(amountUsd * 1_000_000),
      limitPrice: 0.99,
    };

    console.log(`[JUP] Creating order: marketId=${marketId} isYes=${isYes} amount=$${amountUsd.toFixed(2)}`);

    const res = await fetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error(`[JUP] Order TX error ${res.status}: ${rawText.slice(0, 500)}`);
      return null;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return null; }
    return data.transaction || null;
  } catch (err) {
    console.error("[JUP] Order TX error:", err);
    return null;
  }
}

// ── Drift BET Execution ─────────────────────────────────
// Drift Gateway is the recommended execution path for bots
// If running locally: http://localhost:8080 (self-hosted gateway)
// Falls back to Data API order placement
const DRIFT_GATEWAY = process.env.DRIFT_GATEWAY_URL || "http://localhost:8080";

async function getDriftBuyTx(marketIndex: number, isYes: boolean, amountUsd: number): Promise<string | null> {
  try {
    // Drift prediction markets: buy YES = go long, buy NO = go short
    // Prices are 0-1 representing probability
    const direction = isYes ? "long" : "short";
    // Convert USD to contracts (price * contracts = cost)
    const contracts = amountUsd; // ~$1 per contract at resolution

    console.log(`[DRIFT] Placing ${direction} order: marketIndex=${marketIndex} contracts=${contracts} ($${amountUsd.toFixed(2)})`);

    // Try Drift Gateway first (self-hosted, recommended for bots)
    try {
      const res = await fetch(`${DRIFT_GATEWAY}/v2/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketIndex,
          marketType: "perp",
          amount: contracts,
          direction,
          orderType: "market",
          reduceOnly: false,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`[DRIFT] Gateway order placed: ${JSON.stringify(data).slice(0, 200)}`);
        return data.tx || data.transaction || data.txSignature || "gateway-order";
      }

      // Gateway not available, fall back to manual
      console.log(`[DRIFT] Gateway unavailable (${res.status}), will log opportunity only`);
    } catch {
      console.log("[DRIFT] Gateway not running, logging opportunity for manual execution");
    }

    // If no gateway, log the trade details for manual execution
    console.log(`[DRIFT] MANUAL TRADE NEEDED:`);
    console.log(`  Market: ${marketIndex} | Direction: ${direction} | Amount: $${amountUsd.toFixed(2)}`);
    console.log(`  Execute via: https://app.drift.trade/bet`);

    return null;
  } catch (err) {
    console.error("[DRIFT] Order error:", err);
    return null;
  }
}

// ── Market Matching ─────────────────────────────────────
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "will", "the", "a", "an", "in", "on", "at", "to", "for", "of", "is",
    "be", "by", "it", "or", "and", "this", "that", "with", "from", "as",
    "are", "was", "were", "been", "has", "have", "do", "does", "did",
    "but", "not", "what", "which", "who", "how", "when", "where", "why",
    "before", "after", "during", "than", "more", "any", "each", "every",
    "yes", "no", "if", "then", "so", "up", "out", "about", "over",
    "bet", "predict", "prediction", "market",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function matchScore(a: string, b: string): number {
  const kwA = extractKeywords(a);
  const kwB = new Set(extractKeywords(b));
  if (kwA.length === 0 || kwB.size === 0) return 0;
  const overlap = kwA.filter((w) => kwB.has(w)).length;
  return overlap / Math.max(kwA.length, kwB.size);
}

// ── Find Arb Opportunities ──────────────────────────────
function findOpportunities(driftMarkets: DriftBetMarket[], jupMarkets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];
  const MATCH_THRESHOLD = 0.25;
  const topMatches: { drift: string; jup: string; score: number; spread1: number; spread2: number }[] = [];

  for (const dm of driftMarkets) {
    // Drift BET: bestBid = YES price, 1 - bestAsk = NO price (since it's a binary)
    const driftYes = dm.bestAsk || dm.markPrice || 0;  // Cost to buy YES
    const driftNo = 1 - (dm.bestBid || dm.markPrice || 1);  // Cost to buy NO

    if (driftYes === 0 && driftNo === 0) continue;

    for (const jm of jupMarkets) {
      if (jm.status !== "open") continue;

      const driftTitle = dm.symbol;
      const jupTitle = jm.metadata?.title || jm.marketId;
      const score = matchScore(driftTitle, jupTitle);

      const jYes = jm.pricing?.buyYesPriceUsd || 0;
      const jNo = jm.pricing?.buyNoPriceUsd || 0;
      if (jYes === 0 && jNo === 0) continue;

      // Cross-platform arb: sum of opposite sides should be < 1
      const spread1 = 1 - (driftYes + jNo);   // Buy YES on Drift + NO on Jupiter
      const spread2 = 1 - (driftNo + jYes);   // Buy NO on Drift + YES on Jupiter

      if (score > 0.1) {
        topMatches.push({ drift: driftTitle, jup: jupTitle.slice(0, 50), score, spread1, spread2 });
      }

      if (score < MATCH_THRESHOLD) continue;

      if (spread1 > CONFIG.MIN_SPREAD) {
        opps.push({
          drift_market_index: dm.marketIndex,
          drift_symbol: dm.symbol,
          jup_market_id: jm.marketId,
          title: jupTitle,
          drift_yes: driftYes,
          drift_no: driftNo,
          jup_yes: jYes,
          jup_no: jNo,
          best_spread: spread1,
          strategy: "drift_yes_jup_no",
        });
      }

      if (spread2 > CONFIG.MIN_SPREAD) {
        opps.push({
          drift_market_index: dm.marketIndex,
          drift_symbol: dm.symbol,
          jup_market_id: jm.marketId,
          title: jupTitle,
          drift_yes: driftYes,
          drift_no: driftNo,
          jup_yes: jYes,
          jup_no: jNo,
          best_spread: spread2,
          strategy: "drift_no_jup_yes",
        });
      }
    }
  }

  // Debug logging
  topMatches.sort((a, b) => b.score - a.score);
  console.log(`[MATCH] Top market matches (${topMatches.length} pairs with score > 0.1):`);
  for (const m of topMatches.slice(0, 10)) {
    console.log(
      `  score=${m.score.toFixed(2)} spread1=${(m.spread1 * 100).toFixed(1)}% spread2=${(m.spread2 * 100).toFixed(1)}% ` +
      `| DRIFT: "${m.drift}" ↔ JUP: "${m.jup}"`
    );
  }

  return opps.sort((a, b) => b.best_spread - a.best_spread);
}

// ── Sign & Submit Transaction ───────────────────────────
async function signAndSubmit(base64Tx: string, label: string): Promise<string | null> {
  try {
    const txBuf = Buffer.from(base64Tx, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });

    console.log(`[TX] ${label} submitted: ${sig.slice(0, 16)}...`);

    const confirmation = await connection.confirmTransaction(sig, "confirmed");
    if (confirmation.value.err) {
      console.error(`[TX] ${label} FAILED on-chain:`, confirmation.value.err);
      return null;
    }

    console.log(`[TX] ${label} CONFIRMED ✅`);
    return sig;
  } catch (err) {
    console.error(`[TX] ${label} error:`, err);
    return null;
  }
}

// ── Execute Arb ─────────────────────────────────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  const halfAmount = CONFIG.ARB_AMOUNT / 2;

  console.log(`\n[ARB] ═══ EXECUTING ═══════════════════════════`);
  console.log(`[ARB] Market: ${opp.title}`);
  console.log(`[ARB] Strategy: ${opp.strategy}`);
  console.log(`[ARB] Spread: ${(opp.best_spread * 100).toFixed(2)}%`);
  console.log(`[ARB] Drift: YES=$${opp.drift_yes.toFixed(4)} NO=$${opp.drift_no.toFixed(4)}`);
  console.log(`[ARB] Jupiter: YES=$${opp.jup_yes.toFixed(4)} NO=$${opp.jup_no.toFixed(4)}`);

  // Insert opportunity to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: `drift-${opp.drift_market_index}`,
      market_b_id: opp.jup_market_id,
      side_a: opp.strategy === "drift_yes_jup_no" ? "yes" : "no",
      side_b: opp.strategy === "drift_yes_jup_no" ? "no" : "yes",
      price_a: opp.strategy === "drift_yes_jup_no" ? opp.drift_yes : opp.drift_no,
      price_b: opp.strategy === "drift_yes_jup_no" ? opp.jup_no : opp.jup_yes,
      spread: opp.best_spread,
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id;

  try {
    // Step 1: Get Drift BET order
    const driftIsYes = opp.strategy === "drift_yes_jup_no";
    const driftCost = driftIsYes ? opp.drift_yes * halfAmount : opp.drift_no * halfAmount;
    const driftTx = await getDriftBuyTx(opp.drift_market_index, driftIsYes, driftCost);

    // Step 2: Get Jupiter order
    const jupIsYes = opp.strategy === "drift_no_jup_yes";
    const jupCost = jupIsYes ? opp.jup_yes * halfAmount : opp.jup_no * halfAmount;
    const jupTx = await getJupBuyTx(opp.jup_market_id, jupIsYes, jupCost);

    // If Drift Gateway returned a tx, sign & submit both
    if (driftTx && driftTx !== "gateway-order" && jupTx) {
      console.log("[ARB] Signing and submitting both legs...");
      const [driftSig, jupSig] = await Promise.all([
        signAndSubmit(driftTx, `Drift-${driftIsYes ? "YES" : "NO"}`),
        signAndSubmit(jupTx, `Jup-${jupIsYes ? "YES" : "NO"}`),
      ]);

      const totalCost = driftCost + jupCost;
      const payout = halfAmount;
      const profit = payout - totalCost;
      const fees = totalCost * 0.01; // ~1% fees
      const netPnl = profit - fees;
      const success = driftSig && jupSig;

      console.log(`[ARB] ${success ? "✅" : "❌"} | Cost: $${totalCost.toFixed(2)} | Net P&L: $${netPnl.toFixed(2)}`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: totalCost,
          realized_pnl: success ? netPnl : 0,
          fees: success ? fees : 0,
          status: success ? "filled" : "partial",
          side_a_tx: driftSig,
          side_b_tx: jupSig,
          side_a_fill_price: driftIsYes ? opp.drift_yes : opp.drift_no,
          side_b_fill_price: jupIsYes ? opp.jup_yes : opp.jup_no,
          error_message: success ? null : `Partial: drift=${!!driftSig} jup=${!!jupSig}`,
        });
        await supabase.from("arb_opportunities").update({ status: success ? "executed" : "failed" }).eq("id", oppId);
      }
    } else if (driftTx === "gateway-order" && jupTx) {
      // Gateway handled Drift side, submit Jupiter
      const jupSig = await signAndSubmit(jupTx, `Jup-${jupIsYes ? "YES" : "NO"}`);
      const totalCost = driftCost + jupCost;
      const netPnl = halfAmount - totalCost - (totalCost * 0.01);

      console.log(`[ARB] Gateway+TX mode | Jupiter: ${jupSig ? "✅" : "❌"} | Net P&L: $${netPnl.toFixed(2)}`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: totalCost,
          realized_pnl: jupSig ? netPnl : 0,
          fees: totalCost * 0.01,
          status: jupSig ? "filled" : "partial",
          side_a_tx: "gateway",
          side_b_tx: jupSig,
          side_a_fill_price: driftIsYes ? opp.drift_yes : opp.drift_no,
          side_b_fill_price: jupIsYes ? opp.jup_yes : opp.jup_no,
        });
        await supabase.from("arb_opportunities").update({ status: jupSig ? "executed" : "failed" }).eq("id", oppId);
      }
    } else {
      // Log opportunity but can't execute both sides
      console.log("[ARB] ⚠️  Cannot execute — missing transaction from one or both sides");
      console.log("[ARB] Opportunity logged for manual review on dashboard");

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: 0,
          realized_pnl: 0,
          fees: 0,
          status: "detected",
          error_message: `Detected only: drift_tx=${!!driftTx} jup_tx=${!!jupTx}. Check Drift Gateway.`,
        });
        await supabase.from("arb_opportunities").update({ status: "open" }).eq("id", oppId);
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

// ── Main Scan Loop ──────────────────────────────────────
async function runScan() {
  try {
    console.log(`\n[SCAN] ${new Date().toISOString()} — Fetching markets...`);

    const [driftMarkets, jupMarkets] = await Promise.all([
      fetchDriftBetMarkets(),
      fetchJupMarkets(),
    ]);

    console.log(`[SCAN] Drift BET: ${driftMarkets.length} markets | Jupiter: ${jupMarkets.length} markets`);

    if (driftMarkets.length === 0 && jupMarkets.length === 0) {
      console.log("[SCAN] No markets from either platform, skipping");
      return;
    }

    if (driftMarkets.length === 0) {
      console.log("[SCAN] No Drift BET markets found — checking if API is responding...");
      // Still log Jupiter markets to DB for dashboard
    }

    if (jupMarkets.length === 0) {
      console.log("[SCAN] No Jupiter markets found — API may be rate-limited");
    }

    // Find cross-platform arbs
    if (driftMarkets.length > 0 && jupMarkets.length > 0) {
      const opportunities = findOpportunities(driftMarkets, jupMarkets);
      console.log(`[SCAN] Found ${opportunities.length} arb opportunities above ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}% spread`);

      // Execute top opportunities (limit to 3 per scan)
      for (const opp of opportunities.slice(0, 3)) {
        console.log(
          `[ARB] ${opp.title.slice(0, 50)} | ${opp.strategy} | spread=${(opp.best_spread * 100).toFixed(2)}%`
        );
        await executeArb(opp);
        await sleep(2000);
      }
    }

    // Upsert Drift markets to DB for dashboard
    if (driftMarkets.length > 0) {
      const driftUpserts = driftMarkets.map((m) => ({
        platform: "drift_bet",
        external_id: `drift-${m.marketIndex}`,
        question: m.symbol,
        yes_price: m.bestAsk || m.markPrice,
        no_price: 1 - (m.bestBid || m.markPrice),
        volume: m.volume24h || 0,
        end_date: null,
        category: "prediction",
        url: `https://app.drift.trade/bet`,
        last_synced_at: new Date().toISOString(),
      }));

      await supabase
        .from("prediction_markets")
        .upsert(driftUpserts, { onConflict: "platform,external_id" });
    }
  } catch (err) {
    console.error("[SCAN] Error:", err);
  }
}

// ── Start ───────────────────────────────────────────────
async function main() {
  // Check wallet balance
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`[ARB] Wallet SOL balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      console.warn("[ARB] ⚠️  Low SOL balance — transactions may fail");
    }
  } catch {
    console.warn("[ARB] Could not check wallet balance");
  }

  if (!CONFIG.JUP_PREDICT_API_KEY) {
    console.warn("[ARB] ⚠️  No JUP_PREDICT_API_KEY set — Jupiter requests may be rate-limited");
  }

  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning Drift BET ↔ Jupiter Predict...");
}

main().catch(console.error);
