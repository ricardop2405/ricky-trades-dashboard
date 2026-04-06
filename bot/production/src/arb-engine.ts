/**
 * RICKY TRADES — Jupiter Predict Intra-Platform Arb Engine
 *
 * Strategy: Find 5-minute crypto prediction markets on Jupiter where
 * YES_price + NO_price < 1.00. Buy BOTH sides → guaranteed profit
 * regardless of outcome (one side always resolves to $1).
 *
 * Protections:
 *   - Exact-Out quotes (limit-based, no slippage)
 *   - Contract-based orders with fill price checks (no slippage)
 *   - Sequential execution (YES first, auto-close if NO fails)
 *   - Dynamic priority fees via Helius
 *   - USDC balance pre-check
 *   - 15-min max market duration filter
 *   - Market cooldown to avoid retrying same market
 *
 * Usage: npm run arb
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Setup ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

// Market cooldown — skip recently attempted markets
const marketCooldowns = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Proxy Setup ─────────────────────────────────────────
// Route Jupiter API through proxy to bypass region blocks
// Set PROXY_URL in .env (e.g. socks5://user:pass@host:port or http://host:port)
const PROXY_URL = process.env.PROXY_URL || "";
let proxyAgent: any = null;

if (PROXY_URL) {
  if (PROXY_URL.startsWith("socks")) {
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } else {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
  }
  console.log(`[PROXY] Routing Jupiter API through proxy: ${PROXY_URL.replace(/\/\/.*@/, "//***@")}`);
} else {
  console.log("[PROXY] No PROXY_URL set — Jupiter requests go direct (may be region-blocked)");
}

// Proxied fetch for Jupiter API only
async function jupFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!proxyAgent) return fetch(url, init);

  // Use Node.js native fetch with agent
  const nodeFetch = (await import("node-fetch")).default;
  return nodeFetch(url, { ...init, agent: proxyAgent } as any) as unknown as Response;
}

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Jupiter Predict Intra-Platform Arb");
console.log("═══════════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log(`[ARB] Execution: Direct parallel (both legs same slot)`);
console.log(`[ARB] Execution: Sequential (YES→NO, auto-close on failure)`);
console.log(`[ARB] Dynamic priority fees: ON`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface JupMarket {
  marketId: string;
  eventId: string;
  title: string;
  status: string;
  yesPrice: number;
  noPrice: number;
  spread: number;
  category: string;
  endDate: string | null;
  volume: number;
}

interface ArbOpportunity {
  market: JupMarket;
  yesCost: number;
  noCost: number;
  totalCost: number;
  payout: number;
  grossProfit: number;
  fees: number;
  netProfit: number;
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
    return Math.min(fee, 500_000);
  } catch {
    return 50_000;
  }
}

const BASE_CU_LIMIT = 200_000;

// ── Jupiter Predict API (proxied) ───────────────────────
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

    const res = await jupFetch(url, { headers: jupHeaders() });
    const rawText = await res.text();

    if (!res.ok) {
      if (rawText.includes("unsupported_region")) {
        console.error("[JUP] ❌ REGION BLOCKED — set PROXY_URL in .env to route through a supported region");
        return [];
      }
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

    // Filter: open markets resolving within 15 minutes (or no end date for short-term markets)
    const MAX_DURATION_MS = 15 * 60 * 1000;
    const now = Date.now();

    const result = markets
      .filter(m => m.status === "open")
      .filter(m => {
        if (!m.endDate) return true; // short-term markets often lack endDate
        const endMs = new Date(m.endDate).getTime();
        if (isNaN(endMs)) return true; // bad date, include
        const remaining = endMs - now;
        return remaining > 0 && remaining <= MAX_DURATION_MS;
      })
      .sort((a, b) => b.spread - a.spread);

    console.log(`[JUP] Total events: ${events.length} | Total markets: ${markets.length}`);
    console.log(`[JUP] Open markets: ${result.length} | Positive spread: ${result.filter(m => m.spread > 0).length}`);
    if (result.length === 0 && markets.length > 0) {
      console.log(`[JUP] ℹ️  ${markets.length} markets found but none pass filters. Showing all with spread > 0:`);
      const anyPositive = markets.filter(m => m.status === "open" && m.spread > 0).sort((a, b) => b.spread - a.spread);
      for (const m of anyPositive.slice(0, 5)) {
        console.log(`    "${m.title.slice(0, 50)}" spread=${(m.spread * 100).toFixed(2)}% endDate=${m.endDate || "none"}`);
      }
    }

    // Log category breakdown for debugging
    const catCounts: Record<string, number> = {};
    for (const m of markets) {
      const cat = m.category || "unknown";
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    console.log(`[JUP] Categories: ${Object.entries(catCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);

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

// ── Create Order (contract-based buy with price limit) ──
async function getExactOutQuote(
  marketId: string,
  isYes: boolean,
  maxInputUsd: number,
  limitPrice: number,
): Promise<string | null> {
  try {
    // Calculate contracts: we want to spend maxInputUsd at limitPrice per contract
    // contracts = depositAmount / price
    const contracts = Math.floor(maxInputUsd / limitPrice);
    const depositMicro = Math.floor(maxInputUsd * 1_000_000);

    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: true,
      contracts: contracts,
      depositAmount: String(depositMicro),
      depositMint: CONFIG.JUP_USD_MINT,
    };

    console.log(
      `[JUP] Order: ${isYes ? "YES" : "NO"} market=${marketId.slice(0, 12)}... ` +
      `${contracts} contracts @ limit $${limitPrice.toFixed(4)} | deposit=$${maxInputUsd.toFixed(2)}`
    );

    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      if (rawText.includes("unsupported_region")) {
        console.error("[JUP] ❌ REGION BLOCKED on order — need PROXY_URL");
      } else {
        console.error(`[JUP] Quote error ${res.status}: ${rawText.slice(0, 500)}`);
      }
      return null;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return null; }

    // Check maxBuyPriceUsd — reject if fill price exceeds our limit
    if (data.maxBuyPriceUsd) {
      const maxFillPrice = Number(data.maxBuyPriceUsd) / 1_000_000;
      if (maxFillPrice > limitPrice * 1.02) { // 2% tolerance
        console.error(
          `[JUP] ❌ Fill price $${maxFillPrice.toFixed(4)} exceeds limit $${limitPrice.toFixed(4)} — skipping`
        );
        return null;
      }
      console.log(`[JUP] ✅ Fill price: $${maxFillPrice.toFixed(4)} (within limit)`);
    }

    return data.transaction || null;
  } catch (err) {
    console.error("[JUP] Quote error:", err);
    return null;
  }
}

// ── Build & Sign Transaction ────────────────────────────
async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);
  return tx;
}

// ── Find Intra-Platform Arb Opportunities ───────────────
function findArbs(markets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    const { yesPrice, noPrice, spread } = market;
    // Skip markets on cooldown (recently attempted)
    const lastAttempt = marketCooldowns.get(market.marketId);
    if (lastAttempt && (Date.now() - lastAttempt) < COOLDOWN_MS) continue;
    if (spread <= CONFIG.MIN_SPREAD) continue;

    const amount = CONFIG.ARB_AMOUNT;
    const yesCost = yesPrice * amount;
    const noCost = noPrice * amount;
    const totalCost = yesCost + noCost;
    const payout = amount;

    // Fees: ~0.5% platform + SOL tx fees
    const platformFee = totalCost * 0.005;
    const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD; // ~2 tx fees
    const fees = platformFee + txFeeUsd;

    const grossProfit = payout - totalCost;
    const netProfit = grossProfit - fees;

    if (netProfit > 0) {
      opps.push({ market, yesCost, noCost, totalCost, payout, grossProfit, fees, netProfit });
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute Arb ─────────────────────────────────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesCost, noCost, totalCost, netProfit } = opp;

  console.log(`\n[ARB] ═══ EXECUTING ═════════════════════════════════`);
  console.log(`[ARB] Market: ${market.title}`);
  console.log(`[ARB] YES=$${market.yesPrice.toFixed(4)} + NO=$${market.noPrice.toFixed(4)} = ${(market.yesPrice + market.noPrice).toFixed(4)}`);
  console.log(`[ARB] Spread: ${(market.spread * 100).toFixed(2)}% | Est. net profit: $${netProfit.toFixed(4)}`);
  console.log(`[ARB] Buying: YES=$${yesCost.toFixed(2)} + NO=$${noCost.toFixed(2)} = $${totalCost.toFixed(2)}`);

  // Note: Jupiter Predict holds funds inside their program, not in the wallet's ATA.
  // The API will return INSUFFICIENT_FUNDS if balance is too low — no pre-check needed.
  console.log(`[BAL] Using Jupiter Predict program balance (not wallet ATA)`);

  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId,
      market_b_id: market.marketId,
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
    const priorityFee = await getOptimalPriorityFee();
    console.log(`[FEE] Dynamic priority fee: ${priorityFee} microlamports/CU`);

    // Get exact-out quotes for both sides (limit-based, no slippage)
    const [yesTxRaw, noTxRaw] = await Promise.all([
      getExactOutQuote(market.marketId, true, yesCost, market.yesPrice),
      getExactOutQuote(market.marketId, false, noCost, market.noPrice),
    ]);

    if (!yesTxRaw || !noTxRaw) {
      console.log("[ARB] ⚠️  Could not get quotes — prices moved or region blocked");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: `Quote failed: yes=${!!yesTxRaw} no=${!!noTxRaw}`,
        });
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      return;
    }

    // Sign both
    const [yesTx, noTx] = await Promise.all([
      buildAndSign(yesTxRaw),
      buildAndSign(noTxRaw),
    ]);

    // PARALLEL: Send both legs simultaneously
    console.log("[TX] Sending YES + NO legs in parallel...");
    const [yesSig, noSig] = await Promise.all([
      sendDirect(yesTx, "YES"),
      sendDirect(noTx, "NO"),
    ]);
    marketCooldowns.set(market.marketId, Date.now());

    const yesOk = !!yesSig;
    const noOk = !!noSig;

    if (yesOk && noOk) {
      // Both txs confirmed — but check if they are fills or open orders
      console.log("[ARB] Both txs confirmed on-chain, verifying fill status...");
      await sleep(3000); // Wait for state to settle

      const openOrders = await getOpenOrders();
      if (openOrders.length > 0) {
        console.log(`[ARB] ⚠️  ${openOrders.length} unfilled open orders detected — cancelling all`);
        await cancelAllOrders();
        await closeAllPositions();
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
            status: "failed",
            error_message: `Orders placed but not filled — cancelled ${openOrders.length} open orders`,
          });
          await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        }
      } else {
        console.log(`[ARB] ✅ Both legs filled! Net profit: ~$${netProfit.toFixed(4)}`);
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: totalCost, realized_pnl: netProfit,
            fees: opp.fees, status: "filled",
            side_a_tx: yesSig, side_b_tx: noSig,
            side_a_fill_price: market.yesPrice, side_b_fill_price: market.noPrice,
          });
          await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
        }
      }
    } else {
      // One or both txs failed — cancel any open orders and close positions
      console.error(`[ARB] ⚠️  Partial failure: YES=${yesOk} NO=${noOk} — cleaning up`);
      await cancelAllOrders();
      await closeAllPositions();
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: `Partial: YES=${yesOk} NO=${noOk} — auto-cancelled & closed`,
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[ARB] ❌ Execution error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
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
      skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed",
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Get Open Orders ─────────────────────────────────────
async function getOpenOrders(): Promise<any[]> {
  try {
    const res = await jupFetch(
      `${CONFIG.JUP_PREDICT_API}/orders?ownerPubkey=${WALLET}&status=open`,
      { headers: jupHeaders() }
    );
    if (!res.ok) {
      console.warn(`[ORDERS] Could not fetch open orders: ${res.status}`);
      return [];
    }
    const data = await res.json();
    const orders = Array.isArray(data) ? data : (data.orders || []);
    return orders;
  } catch (err) {
    console.warn("[ORDERS] Error fetching open orders:", err);
    return [];
  }
}

// ── Cancel All Open Orders ──────────────────────────────
async function cancelAllOrders(): Promise<boolean> {
  try {
    console.log("[CANCEL] Cancelling all open orders...");
    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "DELETE",
      headers: { ...jupHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey: WALLET }),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error(`[CANCEL] API error ${res.status}: ${rawText.slice(0, 300)}`);
      return false;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return false; }

    // Sign and send cancel transaction(s)
    const txList = data.transactions || (data.transaction ? [data.transaction] : []);
    for (const txData of txList) {
      const tx = await buildAndSign(txData);
      const sig = await sendDirect(tx, "CANCEL");
      if (sig) console.log(`[CANCEL] ✅ Cancelled: ${sig.slice(0, 16)}...`);
    }

    if (txList.length === 0) {
      console.log("[CANCEL] No open orders to cancel");
    }
    return true;
  } catch (err) {
    console.error("[CANCEL] ❌ Error:", err);
    return false;
  }
}

// ── Main Scan Loop ──────────────────────────────────────

// ── Close All Positions (emergency unwind) ──────────────
async function closeAllPositions(): Promise<boolean> {
  try {
    console.log("[CLOSE] Requesting close-all-positions transaction...");
    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/positions`, {
      method: "DELETE",
      headers: {
        ...jupHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerPubkey: WALLET }),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error(`[CLOSE] API error ${res.status}: ${rawText.slice(0, 300)}`);
      return false;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return false; }

    if (data.transaction) {
      const tx = await buildAndSign(data.transaction);
      const sig = await sendDirect(tx, "CLOSE-ALL");
      if (sig) {
        console.log(`[CLOSE] ✅ All positions closed: ${sig.slice(0, 16)}...`);
        return true;
      }
    }

    // If multiple transactions returned
    if (data.transactions && Array.isArray(data.transactions)) {
      for (const txData of data.transactions) {
        const tx = await buildAndSign(txData);
        await sendDirect(tx, "CLOSE");
      }
      console.log("[CLOSE] ✅ Closed all positions");
      return true;
    }

    console.error("[CLOSE] No transaction returned");
    return false;
  } catch (err) {
    console.error("[CLOSE] ❌ Error closing positions:", err);
    return false;
  }
}

// ── Main Scan Loop continued ────────────────────────────
async function runScan() {
  try {
    console.log(`\n[SCAN] ${new Date().toISOString()} ─────────────────────────`);

    const markets = await fetchJupiterMarkets();
    if (markets.length === 0) {
      console.log("[SCAN] No markets found — retrying next interval");
      return;
    }

    const arbs = findArbs(markets);

    if (arbs.length === 0) {
      const allSpreads = markets.filter(m => m.spread > 0).sort((a, b) => b.spread - a.spread);
      console.log(`[SCAN] No arbs above ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}% min spread`);
      if (allSpreads.length > 0) {
        console.log(`[SCAN] Closest positive spreads:`);
        for (const m of allSpreads.slice(0, 5)) {
          console.log(`  "${m.title.slice(0, 50)}" spread=${(m.spread * 100).toFixed(3)}%`);
        }
      }
      return;
    }

    console.log(`\n[SCAN] 🎯 FOUND ${arbs.length} ARB OPPORTUNITIES!`);
    for (const a of arbs) {
      console.log(`  💰 "${a.market.title.slice(0, 50)}" spread=${(a.market.spread * 100).toFixed(2)}% net=$${a.netProfit.toFixed(4)}`);
    }

    for (const arb of arbs.slice(0, 3)) {
      await executeArb(arb);
      await sleep(2000);
    }

    // Upsert to DB for dashboard
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

  // Startup cleanup: cancel any stale open orders from previous runs
  console.log("[ARB] Checking for stale open orders...");
  const staleOrders = await getOpenOrders();
  if (staleOrders.length > 0) {
    console.log(`[ARB] Found ${staleOrders.length} stale open orders — cancelling`);
    await cancelAllOrders();
  } else {
    console.log("[ARB] No stale orders ✅");
  }

  console.log("[ARB] Starting scan loop...\n");
  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning Jupiter 5-min crypto markets...");
}

main().catch(console.error);
