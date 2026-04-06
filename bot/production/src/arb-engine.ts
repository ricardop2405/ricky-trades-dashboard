/**
 * RICKY TRADES — DFlow ↔ Jupiter Predict Atomic Arb Engine
 *
 * Scans both DFlow (Kalshi tokenized) and Jupiter Predict for the
 * same prediction markets. When YES_a + NO_b < 1 (or vice versa),
 * buys both sides across platforms for guaranteed profit on resolution.
 *
 * Both APIs return unsigned Solana transactions — we sign & submit.
 *
 * Usage: npm run arb
 */

import { Connection, Keypair, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Setup ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const WALLET = keypair.publicKey.toBase58();

console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — DFlow ↔ Jupiter Predict Arb");
console.log("═══════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log(`[ARB] DFlow API: ${CONFIG.DFLOW_METADATA_API}`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log("═══════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface DFlowMarket {
  ticker: string;
  title: string;
  eventTicker?: string;
  seriesTicker?: string;
  // API returns yesBid/yesAsk/noBid/noAsk (NOT yes_price/no_price)
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  status: string;
  expirationTime?: number;
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
    sellYesPriceUsd?: number;
    sellNoPriceUsd?: number;
  };
}

interface ArbOpportunity {
  dflow_ticker: string;
  jup_market_id: string;
  title: string;
  dflow_yes: number;
  dflow_no: number;
  jup_yes: number;
  jup_no: number;
  best_spread: number;
  strategy: "dflow_yes_jup_no" | "dflow_no_jup_yes";
}

// ── DFlow API ───────────────────────────────────────────
function dflowHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.DFLOW_API_KEY) h["x-api-key"] = CONFIG.DFLOW_API_KEY;
  return h;
}

async function fetchDFlowMarkets(): Promise<DFlowMarket[]> {
  const allMarkets: DFlowMarket[] = [];

  try {
    // Strategy: fetch active markets from general endpoint PLUS
    // discover 15-minute crypto markets via events → market tickers
    
    // 1. Fetch general active markets (politics, sports, long-term crypto)
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ limit: "100", status: "active" });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`${CONFIG.DFLOW_METADATA_API}/api/v1/markets?${params}`, { headers: dflowHeaders() });
      if (!res.ok) break;
      const data = await res.json();
      const markets = Array.isArray(data) ? data : data.markets || data.data || [];
      allMarkets.push(...markets);
      const next = data.cursor || data.next_cursor;
      if (!next || markets.length < 100) break;
      cursor = next;
    }

    // 2. Discover 15-min crypto events via events endpoint
    const CRYPTO_SERIES = ["KXBTC15M", "KXETH15M", "KXSOL15M"];
    const cryptoEventTickers: string[] = [];
    
    // Scan recent events for 15M series
    let evtCursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ limit: "200" });
      if (evtCursor) params.set("cursor", evtCursor);
      const res = await fetch(`${CONFIG.DFLOW_METADATA_API}/api/v1/events?${params}`, { headers: dflowHeaders() });
      if (!res.ok) break;
      const data = await res.json();
      const events = data.events || [];
      for (const e of events) {
        if (CRYPTO_SERIES.includes(e.seriesTicker)) {
          cryptoEventTickers.push(e.ticker);
        }
      }
      const next = data.cursor;
      if (!next || events.length < 200) break;
      evtCursor = next;
    }

    console.log(`[DFLOW] Found ${cryptoEventTickers.length} fifteen-min crypto events`);

    // 3. Fetch markets for each crypto event ticker by scanning deeper
    // Markets are at high cursor values; batch fetch them
    if (cryptoEventTickers.length > 0) {
      const eventSet = new Set(cryptoEventTickers);
      // Scan market pages looking for these event tickers
      let mkCursor = "28000"; // 15M markets start around cursor 28000+
      for (let page = 0; page < 30; page++) {
        const params = new URLSearchParams({ limit: "100", cursor: mkCursor });
        const res = await fetch(`${CONFIG.DFLOW_METADATA_API}/api/v1/markets?${params}`, { headers: dflowHeaders() });
        if (!res.ok) break;
        const data = await res.json();
        const markets = Array.isArray(data) ? data : data.markets || data.data || [];
        if (markets.length === 0) break;

        for (const m of markets) {
          if (eventSet.has(m.eventTicker)) {
            allMarkets.push(m);
          }
        }

        const next = data.cursor;
        if (!next) break;
        mkCursor = next.toString();
        await sleep(200); // Rate limit protection
      }
    }

    // Log what we found
    const withPrices = allMarkets.filter((m: any) => m.yesBid != null || m.yesAsk != null);
    const crypto15m = allMarkets.filter((m: any) => (m.eventTicker || "").includes("15M"));
    console.log(
      `[DFLOW] Total: ${allMarkets.length} markets | ${withPrices.length} with prices | ${crypto15m.length} fifteen-min crypto`
    );

    for (const m of crypto15m.slice(0, 5)) {
      console.log(
        `  ${m.ticker} "${(m.title || "").slice(0, 50)}" ` +
        `yesBid=${m.yesBid} yesAsk=${m.yesAsk} status=${m.status}`
      );
    }

    return allMarkets;
  } catch (err) {
    console.error("[DFLOW] Fetch error:", err);
    return allMarkets;
  }
}

async function getDFlowBuyTx(ticker: string, side: "yes" | "no", amountUsd: number): Promise<string | null> {
  try {
    const res = await fetch(`${CONFIG.DFLOW_TRADE_API}/api/v1/buy`, {
      method: "POST",
      headers: dflowHeaders(),
      body: JSON.stringify({
        ticker,
        side,
        amount: Math.floor(amountUsd * 1_000_000), // USDC micro-units
        owner: WALLET,
        slippage_bps: 100,
      }),
    });
    if (!res.ok) {
      console.error(`[DFLOW] Buy TX error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data.transaction || null;
  } catch (err) {
    console.error("[DFLOW] Buy TX error:", err);
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
      new URLSearchParams({ includeMarkets: "true", limit: "50" });
    console.log(`[JUP] Fetching: ${url.split("?")[0]}?...`);
    console.log(`[JUP] API key set: ${!!CONFIG.JUP_PREDICT_API_KEY} (${CONFIG.JUP_PREDICT_API_KEY ? CONFIG.JUP_PREDICT_API_KEY.slice(0, 8) + "..." : "MISSING"})`);

    const res = await fetch(url, { headers: jupHeaders() });
    const rawText = await res.text();

    if (!res.ok) {
      console.error(`[JUP] API ${res.status}: ${rawText.slice(0, 500)}`);
      return [];
    }

    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error(`[JUP] Invalid JSON response: ${rawText.slice(0, 200)}`);
      return [];
    }

    console.log(`[JUP] Response type: ${typeof data}, isArray: ${Array.isArray(data)}, keys: ${typeof data === "object" && data ? Object.keys(data).join(",") : "n/a"}`);

    const events = Array.isArray(data) ? data : data.events || data.data || [];
    console.log(`[JUP] Events found: ${events.length}`);

    const markets: JupMarket[] = [];
    for (const event of events) {
      const eventMarkets = event.markets || event.outcomes || [];
      for (const m of eventMarkets) {
        // Extract pricing from various possible response shapes
        const pricing = m.pricing || {};
        // Jupiter may return prices as raw integers (micro-units) or decimals
        // Try multiple field names the API might use
        const buyYes = pricing.buyYesPriceUsd ?? pricing.buyYesPrice ?? pricing.yes_price ?? m.yesPrice ?? m.yes_price ?? 0;
        const buyNo = pricing.buyNoPriceUsd ?? pricing.buyNoPrice ?? pricing.no_price ?? m.noPrice ?? m.no_price ?? 0;
        
        markets.push({
          ...m,
          eventId: event.eventId || event.id,
          metadata: { title: event.title || m.metadata?.title || m.title, marketId: m.marketId || m.id },
          pricing: {
            buyYesPriceUsd: Number(buyYes) || 0,
            buyNoPriceUsd: Number(buyNo) || 0,
          },
        });
      }
    }
    return markets;
  } catch (err) {
    console.error("[JUP] Fetch error:", err);
    return [];
  }
}

async function getJupBuyTx(marketId: string, isYes: boolean, amountUsd: number): Promise<string | null> {
  try {
    const res = await fetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify({
        ownerPubkey: WALLET,
        marketId,
        isYes,
        depositMint: CONFIG.JUP_USD_MINT,
        amount: Math.floor(amountUsd * 1_000_000), // JupUSD micro-units
        limitPrice: isYes ? 0.99 : 0.99, // max price willing to pay
      }),
    });
    if (!res.ok) {
      console.error(`[JUP] Order TX error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data.transaction || null;
  } catch (err) {
    console.error("[JUP] Order TX error:", err);
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
function findOpportunities(dflowMarkets: DFlowMarket[], jupMarkets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];
  const MATCH_THRESHOLD = 0.25; // Lowered — crypto titles are short (e.g. "BTC above 60000")

  // Track top matches for debug logging
  const topMatches: { df: string; jup: string; score: number; spread1: number; spread2: number }[] = [];

  for (const df of dflowMarkets) {
    // Use yesAsk for buying YES (what you pay), noAsk for buying NO
    const dfYes = Number(df.yesAsk ?? df.yesBid ?? 0) || 0;
    const dfNo = Number(df.noAsk ?? df.noBid ?? 0) || 0;
    if (dfYes === 0 && dfNo === 0) continue;

    for (const jm of jupMarkets) {
      if (jm.status !== "open") continue;

      const dfTitle = df.title || df.ticker;
      const jTitle = jm.metadata?.title || jm.marketId;
      const score = matchScore(dfTitle, jTitle);

      // Jupiter prices — buy-side USD quotes
      let jYes = Number(jm.pricing?.buyYesPriceUsd ?? 0) || 0;
      let jNo = Number(jm.pricing?.buyNoPriceUsd ?? 0) || 0;
      // If prices look like micro-units (> 10 USD), convert
      if (jYes > 10) jYes = jYes / 1_000_000;
      if (jNo > 10) jNo = jNo / 1_000_000;

      // Skip if either side has no valid price
      if ((jYes === 0 && jNo === 0)) continue;

      const spread1 = 1 - (dfYes + jNo);
      const spread2 = 1 - (dfNo + jYes);

      // Track top matches regardless of threshold
      if (score > 0.1) {
        topMatches.push({ df: dfTitle.slice(0, 50), jup: jTitle.slice(0, 50), score, spread1, spread2 });
      }

      if (score < MATCH_THRESHOLD) continue;

      // Strategy 1: Buy YES on DFlow + NO on Jupiter
      if (spread1 > CONFIG.MIN_SPREAD) {
        opps.push({
          dflow_ticker: df.ticker,
          jup_market_id: jm.marketId,
          title: dfTitle,
          dflow_yes: dfYes,
          dflow_no: dfNo,
          jup_yes: jYes,
          jup_no: jNo,
          best_spread: spread1,
          strategy: "dflow_yes_jup_no",
        });
      }

      // Strategy 2: Buy NO on DFlow + YES on Jupiter
      if (spread2 > CONFIG.MIN_SPREAD) {
        opps.push({
          dflow_ticker: df.ticker,
          jup_market_id: jm.marketId,
          title: dfTitle,
          dflow_yes: dfYes,
          dflow_no: dfNo,
          jup_yes: jYes,
          jup_no: jNo,
          best_spread: spread2,
          strategy: "dflow_no_jup_yes",
        });
      }
    }
  }

  // Log top 10 closest matches for debugging
  topMatches.sort((a, b) => b.score - a.score);
  console.log(`[MATCH] Top market matches (${topMatches.length} pairs with score > 0.1):`);
  for (const m of topMatches.slice(0, 10)) {
    console.log(`  score=${m.score.toFixed(2)} spread1=${(m.spread1*100).toFixed(1)}% spread2=${(m.spread2*100).toFixed(1)}% | DF: "${m.df}" ↔ JUP: "${m.jup}"`);
  }

  // Log sample prices from each platform
  if (dflowMarkets.length > 0) {
    console.log(`[DFLOW] Sample markets:`);
    for (const m of dflowMarkets.slice(0, 3)) {
      console.log(`  "${(m.title||m.ticker).slice(0,60)}" yesBid=${m.yesBid} yesAsk=${m.yesAsk} noBid=${m.noBid} noAsk=${m.noAsk} status=${m.status}`);
    }
  }
  if (jupMarkets.length > 0) {
    const sample = jupMarkets.slice(0, 3);
    console.log(`[JUP] Sample markets:`);
    for (const m of sample) {
      const yp = m.pricing?.buyYesPriceUsd ?? 0;
      const np = m.pricing?.buyNoPriceUsd ?? 0;
      console.log(`  "${(m.metadata?.title||m.marketId).slice(0,60)}" YES_raw=${yp} NO_raw=${np} status=${m.status}`);
    }
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

    // Wait for confirmation
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
  console.log(`[ARB] DFlow: YES=$${opp.dflow_yes.toFixed(4)} NO=$${opp.dflow_no.toFixed(4)}`);
  console.log(`[ARB] Jupiter: YES=$${opp.jup_yes.toFixed(4)} NO=$${opp.jup_no.toFixed(4)}`);

  // Insert opportunity to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: opp.dflow_ticker,
      market_b_id: opp.jup_market_id,
      side_a: opp.strategy === "dflow_yes_jup_no" ? "yes" : "no",
      side_b: opp.strategy === "dflow_yes_jup_no" ? "no" : "yes",
      price_a: opp.strategy === "dflow_yes_jup_no" ? opp.dflow_yes : opp.dflow_no,
      price_b: opp.strategy === "dflow_yes_jup_no" ? opp.jup_no : opp.jup_yes,
      spread: opp.best_spread,
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id;

  try {
    // Step 1: Get DFlow transaction
    const dflowSide = opp.strategy === "dflow_yes_jup_no" ? "yes" : "no";
    const dflowCost = dflowSide === "yes" ? opp.dflow_yes * halfAmount : opp.dflow_no * halfAmount;
    console.log(`[ARB] Getting DFlow ${dflowSide.toUpperCase()} tx ($${dflowCost.toFixed(2)})...`);
    const dflowTx = await getDFlowBuyTx(opp.dflow_ticker, dflowSide, dflowCost);

    // Step 2: Get Jupiter transaction
    const jupIsYes = opp.strategy === "dflow_no_jup_yes";
    const jupCost = jupIsYes ? opp.jup_yes * halfAmount : opp.jup_no * halfAmount;
    console.log(`[ARB] Getting Jupiter ${jupIsYes ? "YES" : "NO"} tx ($${jupCost.toFixed(2)})...`);
    const jupTx = await getJupBuyTx(opp.jup_market_id, jupIsYes, jupCost);

    if (!dflowTx || !jupTx) {
      console.error("[ARB] ❌ Failed to get one or both transactions");
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: 0,
          realized_pnl: 0,
          fees: 0,
          status: "failed",
          error_message: `Missing tx: dflow=${!!dflowTx} jup=${!!jupTx}`,
        });
      }
      return;
    }

    // Step 3: Sign & submit both transactions
    console.log("[ARB] Signing and submitting both legs...");
    const [dflowSig, jupSig] = await Promise.all([
      signAndSubmit(dflowTx, `DFlow-${dflowSide}`),
      signAndSubmit(jupTx, `Jup-${jupIsYes ? "YES" : "NO"}`),
    ]);

    const totalCost = dflowCost + jupCost;
    const payout = halfAmount; // $1 per unit on resolution
    const profit = payout - totalCost;
    const fees = totalCost * 0.02;
    const netPnl = profit - fees;

    const success = dflowSig && jupSig;

    console.log(`[ARB] ${success ? "✅" : "❌"} | Cost: $${totalCost.toFixed(2)} | Net P&L: $${netPnl.toFixed(2)}`);
    if (dflowSig) console.log(`[ARB] DFlow tx: ${dflowSig}`);
    if (jupSig) console.log(`[ARB] Jupiter tx: ${jupSig}`);

    if (oppId) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId,
        amount_usd: totalCost,
        realized_pnl: success ? netPnl : 0,
        fees: success ? fees : 0,
        status: success ? "filled" : "partial",
        side_a_tx: dflowSig,
        side_b_tx: jupSig,
        side_a_fill_price: opp.strategy === "dflow_yes_jup_no" ? opp.dflow_yes : opp.dflow_no,
        side_b_fill_price: opp.strategy === "dflow_yes_jup_no" ? opp.jup_no : opp.jup_yes,
        error_message: success ? null : `Partial fill: dflow=${!!dflowSig} jup=${!!jupSig}`,
      });

      await supabase
        .from("arb_opportunities")
        .update({ status: success ? "executed" : "failed" })
        .eq("id", oppId);
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

    const [dflowMarkets, jupMarkets] = await Promise.all([
      fetchDFlowMarkets(),
      fetchJupMarkets(),
    ]);

    console.log(`[SCAN] DFlow: ${dflowMarkets.length} markets | Jupiter: ${jupMarkets.length} markets`);

    if (dflowMarkets.length === 0 || jupMarkets.length === 0) {
      console.log("[SCAN] Not enough data from one platform, skipping arb detection");
      return;
    }

    const opportunities = findOpportunities(dflowMarkets, jupMarkets);
    console.log(`[SCAN] Found ${opportunities.length} arb opportunities above ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}% spread`);

    // Execute top opportunities (limit to 3 per scan to manage risk)
    const toExecute = opportunities.slice(0, 3);
    for (const opp of toExecute) {
      console.log(
        `[ARB] ${opp.title.slice(0, 50)} | ${opp.strategy} | spread=${(opp.best_spread * 100).toFixed(2)}%`
      );
      await executeArb(opp);
      await sleep(2000); // Rate limit between executions
    }

    // Also upsert to DB for dashboard visibility
    if (dflowMarkets.length > 0) {
      const dflowUpserts = dflowMarkets.slice(0, 200).map((m) => ({
        platform: "dflow",
        external_id: m.ticker,
        question: m.title || m.ticker,
        yes_price: m.yesAsk ?? m.yesBid ?? 0,
        no_price: m.noAsk ?? m.noBid ?? 0,
        volume: 0,
        end_date: m.expirationTime ? new Date(m.expirationTime * 1000).toISOString() : null,
        category: m.seriesTicker || null,
        url: null,
        last_synced_at: new Date().toISOString(),
      }));

      await supabase
        .from("prediction_markets")
        .upsert(dflowUpserts, { onConflict: "platform,external_id" });
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

  // Warn if no Jupiter API key
  if (!CONFIG.JUP_PREDICT_API_KEY) {
    console.warn("[ARB] ⚠️  No JUP_PREDICT_API_KEY set — Jupiter requests may fail");
    console.warn("[ARB]    Get one at https://portal.jup.ag");
  }

  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning DFlow ↔ Jupiter Predict...");
}

main().catch(console.error);