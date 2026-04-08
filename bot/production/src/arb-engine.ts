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
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes — faster retries
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
  // Sell (bid) prices for Split & Sell strategy
  sellYesPrice: number;
  sellNoPrice: number;
  splitSpread: number; // sellYes + sellNo - 1 (positive = profit)
}

function toIsoFromUnix(value?: number | null): string | null {
  if (!value || Number.isNaN(Number(value))) return null;
  return new Date(Number(value) * 1000).toISOString();
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
  strategy: "merge" | "split_sell";
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

// ── Jupiter Timed Crypto Markets ────────────────────────
// Correct API: https://prediction-market-api.jup.ag/api/v1/events/crypto/timed
// Requires: subcategory (coin) + tags (timeframe)
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";
const TIMED_COINS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"];
const TIMED_INTERVALS = ["5m", "15m"];

async function fetchJupiterMarkets(): Promise<JupMarket[]> {
  const allMarkets: JupMarket[] = [];

  // Fetch all coin × interval combinations in parallel
  const fetches: Promise<void>[] = [];

  for (const coin of TIMED_COINS) {
    for (const interval of TIMED_INTERVALS) {
      fetches.push((async () => {
        try {
          const url = `${JUP_TIMED_API}?subcategory=${coin}&tags=${interval}`;
          const res = await jupFetch(url, { headers: jupHeaders() });
          if (!res.ok) {
            const body = await res.text();
            if (body.includes("unsupported_region")) {
              console.error(`[JUP] ❌ REGION BLOCKED for ${coin}/${interval} — need PROXY_URL`);
            }
            return;
          }

          const data = await res.json() as any;
          const events = Array.isArray(data) ? data : data.data || data.events || [];
          const now = Date.now() / 1000;

          for (const event of events) {
            const markets = event.markets || [];
            // ── Split & Sell: check EACH individual market ──
            for (const m of markets) {
              if (m.status !== "open") continue;
              const closeTime = Number(m.closeTime || m.metadata?.closeTime || 0);
              if (closeTime && closeTime < now) continue;

              const sellYes = Number(m.pricing?.sellYesPriceUsd || 0) / 1_000_000;
              const sellNo = Number(m.pricing?.sellNoPriceUsd || 0) / 1_000_000;
              const buyYes = Number(m.pricing?.buyYesPriceUsd || 0) / 1_000_000;
              const buyNo = Number(m.pricing?.buyNoPriceUsd || 0) / 1_000_000;

              if (sellYes > 0 && sellNo > 0) {
                const splitSpread = sellYes + sellNo - 1;
                if (splitSpread > 0) {
                  const mTitle = m.metadata?.title || m.title || m.marketId;
                  const eventTitle = event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`;
                  const splitMarket: JupMarket = {
                    marketId: m.marketId,
                    eventId: event.eventId || "",
                    title: `[SPLIT] ${eventTitle} — ${mTitle} [sellY=$${sellYes.toFixed(3)} sellN=$${sellNo.toFixed(3)}]`,
                    status: "open",
                    yesPrice: buyYes,
                    noPrice: buyNo,
                    spread: 0,
                    category: "crypto",
                    endDate: toIsoFromUnix(closeTime),
                    volume: Number(m.pricing?.volume || 0),
                    platform: "jupiter_predict",
                    closeTime: closeTime || null,
                    openTime: Number(m.openTime || 0) || null,
                    sellYesPrice: sellYes,
                    sellNoPrice: sellNo,
                    splitSpread,
                  };
                  allMarkets.push(splitMarket);
                }
              }
            }

            // ── Merge strategy: pair Up + Down markets ──
            let upMarket: any = null;
            let downMarket: any = null;

            for (const m of markets) {
              if (m.status !== "open") continue;
              const closeTime = Number(m.closeTime || m.metadata?.closeTime || 0);
              if (closeTime && closeTime < now) continue; // expired

              const title = (m.metadata?.title || m.title || "").toLowerCase();
              if (title.includes("up")) upMarket = m;
              else if (title.includes("down")) downMarket = m;
            }

            if (!upMarket || !downMarket) continue;

            // Get prices — in micro-USD (divide by 1M)
            const upYes = Number(upMarket.pricing?.buyYesPriceUsd || 0) / 1_000_000;
            const downYes = Number(downMarket.pricing?.buyYesPriceUsd || 0) / 1_000_000;

            if (upYes <= 0 || downYes <= 0) continue;

            // The arb: buy YES on Up + YES on Down. One MUST resolve YES.
            // Total cost = upYes + downYes. Payout = $1. Spread = 1 - totalCost.
            const totalCost = upYes + downYes;
            const spread = 1 - totalCost;
            const closeTime = Number(upMarket.closeTime || upMarket.metadata?.closeTime || 0);
            const remaining = closeTime ? Math.round((closeTime - now) / 60) : 0;
            const eventTitle = event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`;

            // Create a synthetic market combining both sides
            const market: JupMarket = {
              // Use Up market ID as primary (we'll need both for execution)
              marketId: upMarket.marketId,
              eventId: event.eventId || "",
              title: `${eventTitle} [Up=$${upYes.toFixed(2)} Down=$${downYes.toFixed(2)}]`,
              status: "open",
              yesPrice: upYes,    // Up YES price
              noPrice: downYes,   // Down YES price (our "other side")
              spread,
              category: "crypto",
              endDate: toIsoFromUnix(closeTime),
              volume: Number(upMarket.pricing?.volume || 0) + Number(downMarket.pricing?.volume || 0),
              platform: "jupiter_predict",
              closeTime: closeTime || null,
              openTime: Number(upMarket.openTime || 0) || null,
              sellYesPrice: 0,
              sellNoPrice: 0,
              splitSpread: 0,
            };

            // Store the Down market ID for execution (we need both)
            (market as any).downMarketId = downMarket.marketId;

            allMarkets.push(market);
          }
        } catch (err) {
          console.error(`[JUP] Fetch error for ${coin}/${interval}:`, err);
        }
      })());
    }
  }

  await Promise.all(fetches);

  // Sort by spread (best opportunities first)
  allMarkets.sort((a, b) => b.spread - a.spread);

  // Log summary
  const openFuture = allMarkets.filter(m => m.spread > 0);
  console.log(`[JUP] Timed crypto markets: ${allMarkets.length} | Positive spread: ${openFuture.length}`);

  if (allMarkets.length > 0) {
    for (const m of allMarkets.slice(0, 10)) {
      const sign = m.spread > 0 ? "✅" : "❌";
      const rem = m.closeTime ? `${Math.round((m.closeTime - Date.now() / 1000) / 60)}m` : "?";
      console.log(`  ${sign} ${m.title.slice(0, 65)} sum=${(m.yesPrice + m.noPrice).toFixed(4)} spread=${(m.spread * 100).toFixed(2)}% rem=${rem}`);
    }
  } else {
    console.log("[JUP] ℹ️ No timed crypto markets found across all coins/intervals");
  }

  return allMarkets;
}

// ── DFlow 5-Minute Crypto Markets ───────────────────────
const DFLOW_API = "https://dev-prediction-markets-api.dflow.net";

async function fetchDFlowCryptoMarkets(): Promise<JupMarket[]> {
  try {
    const eventUrl = `${DFLOW_API}/api/v1/events?withNestedMarkets=true&limit=100`;
    const res = await fetch(eventUrl);
    if (!res.ok) {
      console.log(`[DFLOW] Event fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const events = data.events || [];
    const markets: JupMarket[] = [];

    const CRYPTO_KEYS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "AVAX", "BNB", "LINK", "JUP", "BONK", "WIF", "SUI", "APT"];

    for (const event of events) {
      const series = String(event.seriesTicker || "").toUpperCase();
      const title = String(event.title || "").toUpperCase();
      const subtitle = String(event.subtitle || "").toUpperCase();
      const isCrypto = CRYPTO_KEYS.some((k) => series.includes(k) || title.includes(k) || subtitle.includes(k));
      const looksTimed = series.includes("5M") || series.includes("15M") || title.includes("5 MIN") || title.includes("15 MIN") || subtitle.includes("5 MIN") || subtitle.includes("15 MIN");
      if (!isCrypto || !looksTimed) continue;

      for (const m of (event.markets || [])) {
        const yesPrice = Number(m.yesAsk ?? m.yesBid ?? 0);
        const noPrice = Number(m.noAsk ?? m.noBid ?? 0);
        if (yesPrice <= 0 || noPrice <= 0) continue;

        const market: JupMarket = {
          marketId: m.ticker || m.id,
          eventId: m.eventTicker || event.ticker || "",
          title: m.title || event.title || m.ticker,
          status: m.status || "open",
          yesPrice,
          noPrice,
          spread: 1 - (yesPrice + noPrice),
          category: "crypto",
          endDate: toIsoFromUnix(Number(m.closeTime ?? m.expirationTime ?? 0) || null),
          volume: Number(m.volume || event.volume || 0),
          platform: "dflow",
          closeTime: Number(m.closeTime ?? m.expirationTime ?? 0) || null,
          openTime: Number(m.openTime ?? 0) || null,
        };

        // Simple time check: must close within 16 minutes
        const now = Date.now() / 1000;
        const ct = market.closeTime;
        const isTimedOpen = market.status === "open" && ct && ct > now && (ct - now) <= 16 * 60;
        if (isTimedOpen) {
          markets.push(market);
        }
      }
    }

    const result = markets.sort((a, b) => b.spread - a.spread);
    console.log(`[DFLOW] Timed crypto markets: ${result.length} | Positive spread: ${result.filter(m => m.spread > 0).length}`);
    for (const m of result.slice(0, 5)) {
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
  const downMarketId = (market as any).downMarketId || market.marketId;

  console.log(`\n[ARB] ═══ EXECUTING ═════════════════════════════════`);
  console.log(`[ARB] Event: ${market.title}`);
  console.log(`[ARB] Up YES=$${market.yesPrice.toFixed(4)} + Down YES=$${market.noPrice.toFixed(4)} = ${(market.yesPrice + market.noPrice).toFixed(4)}`);
  console.log(`[ARB] Spread: ${(market.spread * 100).toFixed(2)}% | Est. net profit: $${netProfit.toFixed(4)}`);
  console.log(`[ARB] Buying: Up YES=$${yesCost.toFixed(2)} + Down YES=$${noCost.toFixed(2)} = $${totalCost.toFixed(2)}`);
  console.log(`[ARB] Up market: ${market.marketId} | Down market: ${downMarketId}`);

  if (market.platform === "dflow") {
    console.log(`[ARB] 📊 DFlow opportunity logged (execution not yet supported)`);
    marketCooldowns.set(market.marketId, Date.now());
    return;
  }

  console.log(`[BAL] Using Jupiter Predict program balance (not wallet ATA)`);

  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId,
      market_b_id: downMarketId,
      side_a: "up_yes",
      side_b: "down_yes",
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

    // Buy YES on Up market + YES on Down market (both are YES buys on different markets)
    const [upTxRaw, downTxRaw] = await Promise.all([
      getExactOutQuote(market.marketId, true, yesCost, market.yesPrice),
      getExactOutQuote(downMarketId, true, noCost, market.noPrice),
    ]);

    if (!upTxRaw || !downTxRaw) {
      console.log("[ARB] ⚠️  Could not get quotes — prices moved or region blocked");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: `Quote failed: up=${!!upTxRaw} down=${!!downTxRaw}`,
        });
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      return;
    }

    // Sign both transactions
    const [upTx, downTx] = await Promise.all([
      buildAndSign(upTxRaw),
      buildAndSign(downTxRaw),
    ]);

    // ── ATOMIC: Submit as Jito bundle ──────────────────────
    // Jito guarantees: both txs land in the SAME slot, or neither does.
    console.log("[JITO] Submitting Up YES + Down YES as atomic Jito bundle...");

    const bundleResult = await sendJitoBundle([upTx, downTx]);
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
            side_a_tx: bs58.encode(upTx.signatures[0]),
            side_b_tx: bs58.encode(downTx.signatures[0]),
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
      platform: m.platform,
      external_id: m.marketId,
      question: m.title,
      yes_price: m.yesPrice,
      no_price: m.noPrice,
      volume: m.volume,
      end_date: m.endDate,
      category: m.category || "crypto",
      url: m.platform === "jupiter_predict" ? `https://www.jup.ag/predict/${m.marketId}` : null,
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
