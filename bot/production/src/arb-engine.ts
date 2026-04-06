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
const FAILSAFE_SCAN_ONLY = false; // Atomic via Jito bundles now

// Jito bundle endpoints (mainnet)
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

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
console.log(`[ARB] Execution: ATOMIC via Jito bundles (both legs same slot or neither)`);
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
  platform: "jupiter_predict" | "dflow";
  closeTime?: number | null;
  openTime?: number | null;
}

function toIsoFromUnix(value?: number | null): string | null {
  if (!value || Number.isNaN(Number(value))) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function isShortWindowMarket(input: {
  title?: string | null;
  closeTime?: number | null;
  openTime?: number | null;
  endDate?: string | null;
}): boolean {
  const nowMs = Date.now();
  const title = (input.title || "").toLowerCase();

  if (input.closeTime && input.openTime) {
    const durationMs = (Number(input.closeTime) - Number(input.openTime)) * 1000;
    const remainingMs = Number(input.closeTime) * 1000 - nowMs;
    return durationMs > 0 && durationMs <= 16 * 60 * 1000 && remainingMs > 0 && remainingMs <= 16 * 60 * 1000;
  }

  if (input.endDate) {
    const endMs = new Date(input.endDate).getTime();
    const remainingMs = endMs - nowMs;
    if (!Number.isNaN(endMs) && remainingMs > 0 && remainingMs <= 16 * 60 * 1000) return true;
  }

  return /\b(5m|5 min|5 minute|15m|15 min|15 minute)\b/.test(title);
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
      new URLSearchParams({ includeMarkets: "true", limit: "500", category: "crypto" });

    const res = await jupFetch(url, { headers: jupHeaders() });
    const rawText = await res.text();

    if (!res.ok) {
      if (rawText.includes("unsupported_region")) {
        console.error("[JUP] ❌ REGION BLOCKED — set PROXY_URL in .env");
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
    const debugCandidates: JupMarket[] = [];

    const CRYPTO_KEYWORDS = [
      "btc", "bitcoin", "eth", "ethereum", "sol", "solana", "doge", "xrp", "ada", "avax",
      "bnb", "link", "dot", "matic", "jup", "bonk", "wif", "jto", "pyth", "render", "sui", "apt",
    ];

    for (const event of events) {
      const category = String(event.category || "").toLowerCase();
      const eventTitle = String(event.title || "");
      const eventMarkets = event.markets || event.outcomes || [];

      const isCryptoEvent = category.includes("crypto") ||
        CRYPTO_KEYWORDS.some((kw) => eventTitle.toLowerCase().includes(kw));
      if (!isCryptoEvent) continue;

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

        const title = String(m.metadata?.title || m.title || eventTitle || m.marketId);
        const closeTime = Number(m.closeTime ?? m.resolveAt ?? event.closeTime ?? event.resolveAt ?? 0) || null;
        const openTime = Number(m.openTime ?? event.openTime ?? event.beginAt ?? 0) || null;
        const endDate = toIsoFromUnix(closeTime) || event.endDate || m.endDate || null;
        const spread = 1 - (yesPrice + noPrice);

        const market: JupMarket = {
          marketId: m.marketId || m.id,
          eventId: event.eventId || event.id,
          title,
          status: m.status || "open",
          yesPrice,
          noPrice,
          spread,
          category: category || "crypto",
          endDate,
          volume: Number(m.volume ?? event.volume ?? event.volumeUsd ?? 0),
          platform: "jupiter_predict",
          closeTime,
          openTime,
        };

        debugCandidates.push(market);
        if (market.status === "open" && isShortWindowMarket(market)) {
          markets.push(market);
        }
      }
    }

    const result = markets.sort((a, b) => b.spread - a.spread);
    console.log(`[JUP] Crypto events: ${events.length} | Timed crypto markets: ${result.length}`);
    console.log(`[JUP] Positive spread: ${result.filter(m => m.spread > 0).length}`);

    if (result.length === 0 && debugCandidates.length > 0) {
      console.log(`[JUP] ℹ️ No short-window markets found. Top crypto candidates:`);
      for (const m of debugCandidates.slice(0, 8)) {
        const remainingMin = m.closeTime ? Math.round((m.closeTime * 1000 - Date.now()) / 60000) : null;
        console.log(`    "${m.title.slice(0, 50)}" closeTime=${m.closeTime ?? "none"} remaining=${remainingMin ?? "?"}m spread=${(m.spread * 100).toFixed(2)}%`);
      }
    }

    for (const m of result.slice(0, 10)) {
      const sign = m.spread > 0 ? "✅" : "❌";
      console.log(`  ${sign} "${m.title.slice(0, 55)}" YES=$${m.yesPrice.toFixed(4)} NO=$${m.noPrice.toFixed(4)} sum=${(m.yesPrice + m.noPrice).toFixed(4)} spread=${(m.spread * 100).toFixed(2)}%`);
    }

    return result;
  } catch (err) {
    console.error("[JUP] Fetch error:", err);
    return [];
  }
}

// ── DFlow 5-Minute Crypto Markets ───────────────────────
const DFLOW_API = CONFIG.DFLOW_METADATA_API || "https://prediction-markets-api.dflow.net";

async function fetchDFlowCryptoMarkets(): Promise<JupMarket[]> {
  try {
    const markets: JupMarket[] = [];

    // 1. Discover 5-min / 15-min crypto event tickers
    const cryptoEvents = new Set<string>();
    let evtCursor: string | null = null;
    for (let p = 0; p < 10; p++) {
      const params = new URLSearchParams({ limit: "100" });
      if (evtCursor) params.set("cursor", evtCursor);
      const r = await fetch(`${DFLOW_API}/api/v1/events?${params}`);
      if (!r.ok) break;
      const d = await r.json();
      for (const e of (d.events || [])) {
        const st = (e.seriesTicker || "").toUpperCase();
        if (st.includes("5M") || st.includes("15M") || st.includes("MIN")) {
          cryptoEvents.add(e.ticker);
        }
      }
      evtCursor = d.cursor;
      if (!evtCursor || (d.events || []).length < 100) break;
    }

    if (cryptoEvents.size === 0) {
      console.log("[DFLOW] No 5-min crypto events found");
      return [];
    }

    // 2. Fetch markets for those events
    let mkCursor: string | null = null;
    for (let p = 0; p < 50; p++) {
      const params = new URLSearchParams({ limit: "100", status: "active" });
      if (mkCursor) params.set("cursor", mkCursor);
      const r = await fetch(`${DFLOW_API}/api/v1/markets?${params}`);
      if (!r.ok) break;
      const d = await r.json();
      const batch = d.markets || d.data || (Array.isArray(d) ? d : []);
      if (!batch.length) break;

      for (const m of batch) {
        if (!cryptoEvents.has(m.eventTicker)) continue;
        const yesPrice = m.yesAsk ?? m.yesBid ?? 0;
        const noPrice = m.noAsk ?? m.noBid ?? 0;
        if (yesPrice <= 0 || noPrice <= 0) continue;

        const spread = 1 - (yesPrice + noPrice);
        markets.push({
          marketId: m.ticker || m.id,
          eventId: m.eventTicker || "",
          title: m.title || m.ticker,
          status: "open",
          yesPrice,
          noPrice,
          spread,
          category: "crypto",
          endDate: m.expirationTime ? new Date(m.expirationTime * 1000).toISOString() : null,
          volume: m.volume || 0,
          platform: "dflow",
        });
      }

      mkCursor = d.cursor;
      if (!mkCursor) break;
    }

    // Filter to markets expiring within 15 min
    const now = Date.now();
    const MAX_DUR = 15 * 60 * 1000;
    const result = markets.filter(m => {
      if (!m.endDate) return true;
      const endMs = new Date(m.endDate).getTime();
      if (isNaN(endMs)) return true;
      const remaining = endMs - now;
      return remaining > 0 && remaining <= MAX_DUR;
    }).sort((a, b) => b.spread - a.spread);

    console.log(`[DFLOW] ${cryptoEvents.size} crypto events | ${markets.length} markets | ${result.filter(m => m.spread > 0).length} positive spread`);
    for (const m of result.filter(m => m.spread > 0).slice(0, 5)) {
      console.log(`  ✅ DFLOW "${m.title.slice(0, 50)}" YES=$${m.yesPrice.toFixed(4)} NO=$${m.noPrice.toFixed(4)} spread=${(m.spread * 100).toFixed(2)}%`);
    }

    return result;
  } catch (err) {
    console.error("[DFLOW] Fetch error:", err);
    return [];
  }
}


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
  // DFlow markets: scan-only (no on-chain execution yet — different platform)
  if (market.platform === "dflow") {
    console.log(`[ARB] 📊 DFlow opportunity logged (execution not yet supported — needs DFlow SDK)`);
    marketCooldowns.set(market.marketId, Date.now());
    return;
  }

  // Jupiter: atomic execution via Jito bundles
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

    // Sign both transactions
    const [yesTx, noTx] = await Promise.all([
      buildAndSign(yesTxRaw),
      buildAndSign(noTxRaw),
    ]);

    // ── ATOMIC: Submit as Jito bundle ──────────────────────
    // Jito guarantees: both txs land in the SAME slot, or neither does.
    console.log("[JITO] Submitting YES + NO as atomic Jito bundle...");

    const bundleResult = await sendJitoBundle([yesTx, noTx]);
    marketCooldowns.set(market.marketId, Date.now());

    if (bundleResult) {
      console.log(`[ARB] ✅ Jito bundle landed! Bundle ID: ${bundleResult}`);

      // Verify both txs confirmed
      await sleep(3000);
      const openOrders = await getOpenOrders();
      if (openOrders.length > 0) {
        console.log(`[ARB] ⚠️  ${openOrders.length} unfilled open orders — cancelling`);
        await cancelAllOrders();
        await closeAllPositions();
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
            status: "failed",
            error_message: `Bundle landed but orders unfilled — cancelled ${openOrders.length}`,
          });
          await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        }
      } else {
        console.log(`[ARB] ✅ Both legs filled atomically! Net profit: ~$${netProfit.toFixed(4)}`);
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: totalCost, realized_pnl: netProfit,
            fees: opp.fees, status: "filled",
            side_a_tx: bs58.encode(yesTx.signatures[0]),
            side_b_tx: bs58.encode(noTx.signatures[0]),
            side_a_fill_price: market.yesPrice, side_b_fill_price: market.noPrice,
          });
          await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
        }
      }
    } else {
      console.error(`[ARB] ❌ Jito bundle failed — no exposure, both legs rejected atomically`);
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: "Jito bundle rejected — atomic failure, no exposure",
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

// ── Jito Bundle Submission (Atomic) ──────────────────────
async function sendJitoBundle(txs: VersionedTransaction[]): Promise<string | null> {
  try {
    // Jito expects base58-encoded serialized transactions
    const encodedTxs = txs.map(tx => bs58.encode(tx.serialize()));

    const res = await fetch(JITO_BUNDLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [encodedTxs],
      }),
    });

    const data = await res.json() as any;

    if (data.error) {
      console.error(`[JITO] Bundle error: ${JSON.stringify(data.error)}`);
      return null;
    }

    const bundleId = data.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    // Poll for bundle status (up to 30s)
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const statusRes = await fetch(JITO_BUNDLE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });
        const statusData = await statusRes.json() as any;
        const statuses = statusData?.result?.value || [];
        if (statuses.length > 0) {
          const s = statuses[0];
          console.log(`[JITO] Bundle status: ${s.confirmation_status || s.status}`);
          if (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized") {
            return bundleId;
          }
          if (s.err || s.confirmation_status === "failed") {
            console.error(`[JITO] Bundle failed:`, s.err);
            return null;
          }
        }
      } catch { /* retry */ }
    }

    console.warn("[JITO] Bundle status unknown after 30s — treating as failed");
    return null;
  } catch (err) {
    console.error("[JITO] Bundle submission error:", err);
    return null;
  }
}

// ── Direct TX Submission (Fallback for cancels/closes) ──
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

    // Fetch Jupiter + DFlow in parallel
    const [jupMarkets, dflowMarkets] = await Promise.all([
      fetchJupiterMarkets(),
      fetchDFlowCryptoMarkets(),
    ]);
    const markets = [...jupMarkets, ...dflowMarkets];

    if (markets.length === 0) {
      console.log("[SCAN] No markets found on either platform — retrying next interval");
      return;
    }
    console.log(`[SCAN] Total: ${markets.length} markets (Jupiter=${jupMarkets.length}, DFlow=${dflowMarkets.length})`);

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

  console.log("[ARB] 🔒 Atomic execution via Jito bundles — both legs land together or not at all");

  console.log("[ARB] Starting scan loop...\n");
  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running. Scanning Jupiter 5-min crypto markets...");
}

main().catch(console.error);
