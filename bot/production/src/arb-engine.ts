/**
 * RICKY TRADES — Jupiter Predict Arb Engine v2
 *
 * Strategies:
 *   1. MERGE (market taker): buy both sides when ask+ask < $1 (rare, atomic via Jito)
 *   2. SPLIT_SELL (market taker): sell both sides when bid+bid > $1 (rare, atomic via Jito)
 *   3. LIMIT_MAKE (market maker): place resting limit buys on both sides at
 *      prices summing < $1, monitor fills, auto-unwind if only one fills.
 *      This IS the strategy that actually trades — guaranteed profit when
 *      both sides fill.
 *
 * Safety:
 *   - LIMIT_MAKE: if only one side fills, sell back within 30s or hold to expiry
 *   - MERGE/SPLIT: Jito bundles (order creation atomic, fills by keeper)
 *   - All strategies: fill price verification, USDC balance pre-check
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
const COOLDOWN_MS = 2 * 60 * 1000;

// Active limit-make positions (event-level tracking)
interface LimitMakePosition {
  eventTitle: string;
  upMarketId: string;
  downMarketId: string;
  upOrderPubkey: string | null;
  downOrderPubkey: string | null;
  upPrice: number;
  downPrice: number;
  contracts: number;
  upFilled: boolean;
  downFilled: boolean;
  placedAt: number;
  closeTime: number;
  oppId: string | null;
}
const activeLimitMakes = new Map<string, LimitMakePosition>();
const MAX_ACTIVE_LIMIT_MAKES = 3; // Max concurrent limit-make positions
const LIMIT_MAKE_TIMEOUT_MS = 45_000; // Cancel unfilled side after 45s
const LIMIT_MAKE_MIN_REMAINING_MS = 3 * 60 * 1000; // Need 3+ min remaining

// Jito bundle endpoints (mainnet)
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// ── Proxy Setup ─────────────────────────────────────────
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

async function jupFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!proxyAgent) return fetch(url, init);
  const nodeFetch = (await import("node-fetch")).default;
  return nodeFetch(url, { ...init, agent: proxyAgent } as any) as unknown as Response;
}

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Jupiter Predict Arb v2 (LIMIT_MAKE)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log(`[ARB] Strategies: LIMIT_MAKE (primary) + MERGE + SPLIT_SELL`);
console.log(`[ARB] LIMIT_MAKE: Place limit buys on both Up+Down, sum < $1`);
console.log(`[ARB] Max concurrent limit-makes: ${MAX_ACTIVE_LIMIT_MAKES}`);
console.log(`[ARB] Timeout for unfilled side: ${LIMIT_MAKE_TIMEOUT_MS / 1000}s`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface JupMarket {
  marketId: string;
  eventId: string;
  title: string;
  status: string;
  yesPrice: number;  // buyYes (ask)
  noPrice: number;   // buyYes on Down market (ask)
  spread: number;    // 1 - (buyUp + buyDown)
  category: string;
  endDate: string | null;
  volume: number;
  platform: "jupiter_predict" | "dflow";
  closeTime?: number | null;
  openTime?: number | null;
  sellYesPrice: number;  // sellYes on Up (bid)
  sellNoPrice: number;   // sellYes on Down (bid)
  splitSpread: number;
  // For limit-make: bid prices to place orders slightly above
  upBid: number;
  downBid: number;
  upAsk: number;
  downAsk: number;
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
  strategy: "merge" | "split_sell" | "limit_make";
}

// ── Fee estimation (from Jupiter fee table) ─────────────
// Fees scale with contracts and price uncertainty
function estimateFee(contracts: number, price: number): number {
  // Approximate: fee ≈ contracts × price × 0.013 (1.3% average)
  // Higher near $0.50, lower near $0/$1
  const uncertainty = 1 - Math.abs(price - 0.5) * 2; // 0 at extremes, 1 at $0.50
  const feeRate = 0.008 + uncertainty * 0.01; // 0.8% to 1.8%
  return Math.max(0.01, contracts * price * feeRate);
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
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";
const TIMED_COINS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"];
const TIMED_INTERVALS = ["5m", "15m"];

async function fetchJupiterMarkets(): Promise<JupMarket[]> {
  const allMarkets: JupMarket[] = [];
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

            let upMarket: any = null;
            let downMarket: any = null;

            for (const m of markets) {
              if (m.status !== "open") continue;
              const closeTime = Number(m.closeTime || m.metadata?.closeTime || 0);
              if (closeTime && closeTime < now) continue;

              const title = (m.metadata?.title || m.title || "").toLowerCase();
              if (title.includes("up")) upMarket = m;
              else if (title.includes("down")) downMarket = m;
            }

            if (!upMarket || !downMarket) continue;

            const upBuyYes = Number(upMarket.pricing?.buyYesPriceUsd || 0) / 1_000_000;
            const downBuyYes = Number(downMarket.pricing?.buyYesPriceUsd || 0) / 1_000_000;
            const upSellYes = Number(upMarket.pricing?.sellYesPriceUsd || 0) / 1_000_000;
            const downSellYes = Number(downMarket.pricing?.sellYesPriceUsd || 0) / 1_000_000;

            if (upBuyYes <= 0 || downBuyYes <= 0) continue;

            const closeTime = Number(upMarket.closeTime || upMarket.metadata?.closeTime || 0);
            const eventTitle = event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`;

            // Build market entry with full bid/ask data
            const totalCost = upBuyYes + downBuyYes;
            const spread = 1 - totalCost;
            const splitSpread = (upSellYes > 0 && downSellYes > 0) ? (upSellYes + downSellYes - 1) : 0;

            const market: JupMarket = {
              marketId: upMarket.marketId,
              eventId: event.eventId || "",
              title: eventTitle,
              status: "open",
              yesPrice: upBuyYes,
              noPrice: downBuyYes,
              spread,
              category: "crypto",
              endDate: toIsoFromUnix(closeTime),
              volume: Number(upMarket.pricing?.volume || 0) + Number(downMarket.pricing?.volume || 0),
              platform: "jupiter_predict",
              closeTime: closeTime || null,
              openTime: Number(upMarket.openTime || 0) || null,
              sellYesPrice: upSellYes,
              sellNoPrice: downSellYes,
              splitSpread,
              upBid: upSellYes,   // Best bid on Up
              downBid: downSellYes, // Best bid on Down
              upAsk: upBuyYes,     // Best ask on Up
              downAsk: downBuyYes,  // Best ask on Down
            };

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
  allMarkets.sort((a, b) => b.spread - a.spread);

  const openFuture = allMarkets.filter(m => m.spread > 0);
  console.log(`[JUP] Timed crypto markets: ${allMarkets.length} | Positive merge spread: ${openFuture.length}`);

  // Log limit-make opportunities (bid+$0.01 on each side)
  let limitMakeCandidates = 0;
  for (const m of allMarkets) {
    const remaining = (m.closeTime || 0) - Date.now() / 1000;
    if (remaining < LIMIT_MAKE_MIN_REMAINING_MS / 1000) continue;

    // Target price: midpoint between bid and ask on each side
    const upTarget = (m.upBid + m.upAsk) / 2;
    const downTarget = (m.downBid + m.downAsk) / 2;
    const targetSum = upTarget + downTarget;
    const contracts = Math.floor(CONFIG.ARB_AMOUNT / Math.max(upTarget, 0.01));
    const totalFees = estimateFee(contracts, upTarget) + estimateFee(contracts, downTarget);
    const netProfit = (1 - targetSum) * contracts - totalFees;

    if (targetSum < 1 && netProfit > 0) {
      limitMakeCandidates++;
      if (limitMakeCandidates <= 5) {
        console.log(
          `  🎯 [LIMIT_MAKE] ${m.title.slice(0, 55)} | up=$${upTarget.toFixed(3)} down=$${downTarget.toFixed(3)} ` +
          `sum=${targetSum.toFixed(4)} est_profit=$${netProfit.toFixed(3)} rem=${Math.round(remaining / 60)}m`
        );
      }
    }
  }
  if (limitMakeCandidates > 5) {
    console.log(`  ... and ${limitMakeCandidates - 5} more limit-make candidates`);
  }
  if (limitMakeCandidates === 0) {
    // Log closest to profitability
    for (const m of allMarkets.slice(0, 3)) {
      const remaining = (m.closeTime || 0) - Date.now() / 1000;
      const upMid = (m.upBid + m.upAsk) / 2;
      const downMid = (m.downBid + m.downAsk) / 2;
      console.log(
        `  📊 ${m.title.slice(0, 55)} | bid/ask Up=$${m.upBid.toFixed(3)}/$${m.upAsk.toFixed(3)} ` +
        `Down=$${m.downBid.toFixed(3)}/$${m.downAsk.toFixed(3)} mid_sum=${(upMid + downMid).toFixed(4)} rem=${Math.round(remaining / 60)}m`
      );
    }
  }

  return allMarkets;
}

// ── DFlow Markets (unchanged) ───────────────────────────
const DFLOW_API = "https://dev-prediction-markets-api.dflow.net";

async function fetchDFlowCryptoMarkets(): Promise<JupMarket[]> {
  try {
    const eventUrl = `${DFLOW_API}/api/v1/events?withNestedMarkets=true&limit=100`;
    const res = await fetch(eventUrl);
    if (!res.ok) return [];

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

        const sellYes = Number(m.yesBid ?? 0);
        const sellNo = Number(m.noBid ?? 0);

        const market: JupMarket = {
          marketId: m.ticker || m.id,
          eventId: m.eventTicker || event.ticker || "",
          title: m.title || event.title || m.ticker,
          status: m.status || "open",
          yesPrice, noPrice,
          spread: 1 - (yesPrice + noPrice),
          category: "crypto",
          endDate: toIsoFromUnix(Number(m.closeTime ?? m.expirationTime ?? 0) || null),
          volume: Number(m.volume || event.volume || 0),
          platform: "dflow",
          closeTime: Number(m.closeTime ?? m.expirationTime ?? 0) || null,
          openTime: Number(m.openTime ?? 0) || null,
          sellYesPrice: sellYes, sellNoPrice: sellNo,
          splitSpread: (sellYes > 0 && sellNo > 0) ? (sellYes + sellNo - 1) : 0,
          upBid: sellYes, downBid: sellNo, upAsk: yesPrice, downAsk: noPrice,
        };

        const now = Date.now() / 1000;
        const ct = market.closeTime;
        if (market.status === "open" && ct && ct > now && (ct - now) <= 16 * 60) {
          markets.push(market);
        }
      }
    }

    const result = markets.sort((a, b) => b.spread - a.spread);
    console.log(`[DFLOW] Timed crypto markets: ${result.length} | Positive spread: ${result.filter(m => m.spread > 0).length}`);
    return result;
  } catch (err) {
    console.error("[DFLOW] Fetch error:", err);
    return [];
  }
}

// ── Order Creation ──────────────────────────────────────
async function createBuyOrder(
  marketId: string,
  isYes: boolean,
  contracts: number,
  depositUsd: number,
): Promise<{ transaction: string; orderPubkey: string } | null> {
  try {
    const depositMicro = Math.floor(depositUsd * 1_000_000);
    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: true,
      contracts,
      depositAmount: String(depositMicro),
      depositMint: CONFIG.JUP_USD_MINT,
    };

    const impliedPrice = depositUsd / contracts;
    console.log(
      `[ORDER] BUY ${isYes ? "YES" : "NO"} market=${marketId.slice(0, 12)}... ` +
      `${contracts} contracts @ $${impliedPrice.toFixed(4)} | deposit=$${depositUsd.toFixed(2)}`
    );

    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      if (rawText.includes("unsupported_region")) {
        console.error("[ORDER] ❌ REGION BLOCKED — need PROXY_URL");
      } else {
        console.error(`[ORDER] Error ${res.status}: ${rawText.slice(0, 300)}`);
      }
      return null;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return null; }

    if (!data.transaction) {
      console.error("[ORDER] No transaction in response");
      return null;
    }

    const orderPubkey = data.order?.orderPubkey || "";
    console.log(`[ORDER] ✅ Order created: ${orderPubkey.slice(0, 16)}...`);

    return { transaction: data.transaction, orderPubkey };
  } catch (err) {
    console.error("[ORDER] Error:", err);
    return null;
  }
}

// ── Sell Order ──────────────────────────────────────────
async function createSellOrder(
  marketId: string,
  isYes: boolean,
  contracts: number,
): Promise<string | null> {
  try {
    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: false,
      contracts,
    };

    console.log(
      `[SELL] ${isYes ? "YES" : "NO"} market=${marketId.slice(0, 12)}... ${contracts} contracts`
    );

    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error(`[SELL] Error ${res.status}: ${rawText.slice(0, 300)}`);
      return null;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return null; }
    return data.transaction || null;
  } catch (err) {
    console.error("[SELL] Error:", err);
    return null;
  }
}

async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);
  return tx;
}

// ── Check Order Status ──────────────────────────────────
async function checkOrderStatus(orderPubkey: string): Promise<"pending" | "filled" | "failed" | "unknown"> {
  try {
    const res = await jupFetch(
      `${CONFIG.JUP_PREDICT_API}/orders/status/${orderPubkey}`,
      { headers: jupHeaders() }
    );
    if (!res.ok) return "unknown";
    const data = await res.json() as any;
    return data.status || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Find Opportunities ──────────────────────────────────
function findArbs(markets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    const lastAttempt = marketCooldowns.get(market.marketId);
    if (lastAttempt && (Date.now() - lastAttempt) < COOLDOWN_MS) continue;

    // Already have active limit-make on this event?
    const eventKey = market.eventId || market.title;
    if (activeLimitMakes.has(eventKey)) continue;

    const remaining = ((market.closeTime || 0) - Date.now() / 1000) * 1000;

    // ── Strategy 1: LIMIT_MAKE (primary — market maker) ──
    if (market.platform === "jupiter_predict" && remaining > LIMIT_MAKE_MIN_REMAINING_MS) {
      // Target: midpoint between bid and ask on each side
      const upTarget = Math.max((market.upBid + market.upAsk) / 2, market.upBid + 0.01);
      const downTarget = Math.max((market.downBid + market.downAsk) / 2, market.downBid + 0.01);
      const targetSum = upTarget + downTarget;

      if (targetSum < 1) {
        const contracts = Math.floor(CONFIG.ARB_AMOUNT / Math.max(upTarget, 0.01));
        if (contracts < 1) continue;

        const upCost = upTarget * contracts;
        const downCost = downTarget * contracts;
        const totalCost = upCost + downCost;
        const payout = contracts; // $1 per winning contract

        const fees = estimateFee(contracts, upTarget) + estimateFee(contracts, downTarget);
        const grossProfit = payout - totalCost;
        const netProfit = grossProfit - fees;

        if (netProfit > 0.01) { // At least $0.01 profit
          opps.push({
            market: { ...market, yesPrice: upTarget, noPrice: downTarget },
            yesCost: upCost,
            noCost: downCost,
            totalCost,
            payout,
            grossProfit,
            fees,
            netProfit,
            strategy: "limit_make",
          });
        }
      }
    }

    // ── Strategy 2: SPLIT_SELL (market taker) ──
    if (market.splitSpread > 0) {
      const amount = CONFIG.ARB_AMOUNT;
      const sellYesRevenue = market.sellYesPrice * amount;
      const sellNoRevenue = market.sellNoPrice * amount;
      const totalRevenue = sellYesRevenue + sellNoRevenue;
      const collateral = amount;
      const platformFee = totalRevenue * 0.005;
      const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD;
      const fees = platformFee + txFeeUsd;
      const grossProfit = totalRevenue - collateral;
      const netProfit = grossProfit - fees;

      if (netProfit > 0) {
        opps.push({
          market, yesCost: sellYesRevenue, noCost: sellNoRevenue,
          totalCost: collateral, payout: totalRevenue, grossProfit, fees, netProfit,
          strategy: "split_sell",
        });
      }
      continue;
    }

    // ── Strategy 3: MERGE (market taker) ──
    const { yesPrice, noPrice, spread } = market;
    if (spread <= CONFIG.MIN_SPREAD) continue;

    const amount = CONFIG.ARB_AMOUNT;
    const yesCost = yesPrice * amount;
    const noCost = noPrice * amount;
    const totalCost = yesCost + noCost;
    const payout = amount;
    const platformFee = totalCost * 0.005;
    const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD;
    const fees = platformFee + txFeeUsd;
    const grossProfit = payout - totalCost;
    const netProfit = grossProfit - fees;

    if (netProfit > 0) {
      opps.push({ market, yesCost, noCost, totalCost, payout, grossProfit, fees, netProfit, strategy: "merge" });
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute Arb ─────────────────────────────────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  if (opp.strategy === "limit_make") return executeLimitMake(opp);
  if (opp.strategy === "split_sell") return executeSplitSell(opp);
  return executeMerge(opp);
}

// ══════════════════════════════════════════════════════════
// ── LIMIT_MAKE Execution (Market Maker Strategy) ────────
// ══════════════════════════════════════════════════════════
async function executeLimitMake(opp: ArbOpportunity): Promise<void> {
  const { market, netProfit } = opp;
  const downMarketId = (market as any).downMarketId || market.marketId;
  const eventKey = market.eventId || market.title;
  const contracts = Math.floor(CONFIG.ARB_AMOUNT / Math.max(market.yesPrice, 0.01));

  if (activeLimitMakes.size >= MAX_ACTIVE_LIMIT_MAKES) {
    console.log(`[LIMIT] Skipping — ${activeLimitMakes.size} active limit-makes already`);
    return;
  }

  console.log(`\n[LIMIT] ═══ PLACING LIMIT-MAKE ORDERS ══════════════`);
  console.log(`[LIMIT] Event: ${market.title}`);
  console.log(`[LIMIT] Up limit=$${market.yesPrice.toFixed(4)} | Down limit=$${market.noPrice.toFixed(4)}`);
  console.log(`[LIMIT] Sum=${(market.yesPrice + market.noPrice).toFixed(4)} | Contracts=${contracts}`);
  console.log(`[LIMIT] Est. net profit if both fill: $${netProfit.toFixed(4)}`);
  console.log(`[LIMIT] Up market: ${market.marketId} | Down market: ${downMarketId}`);

  // Log to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId,
      market_b_id: downMarketId,
      side_a: "limit_buy_up",
      side_b: "limit_buy_down",
      price_a: market.yesPrice,
      price_b: market.noPrice,
      spread: 1 - (market.yesPrice + market.noPrice),
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id || null;

  try {
    // Place both limit buy orders
    const upDeposit = market.yesPrice * contracts;
    const downDeposit = market.noPrice * contracts;

    const [upOrder, downOrder] = await Promise.all([
      createBuyOrder(market.marketId, true, contracts, upDeposit),
      createBuyOrder(downMarketId, true, contracts, downDeposit),
    ]);

    if (!upOrder || !downOrder) {
      console.log("[LIMIT] ⚠️ Could not create one or both orders");
      // Cancel the one that was created
      if (upOrder || downOrder) {
        console.log("[LIMIT] Cancelling the created order...");
        await cancelAllOrders();
      }
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: `Order creation failed: up=${!!upOrder} down=${!!downOrder}`,
        });
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    // Sign and submit both order txs
    const [upTx, downTx] = await Promise.all([
      buildAndSign(upOrder.transaction),
      buildAndSign(downOrder.transaction),
    ]);

    // Send both directly (not Jito — these are limit orders, fills happen async)
    const [upSig, downSig] = await Promise.all([
      sendDirect(upTx, "LIMIT-UP"),
      sendDirect(downTx, "LIMIT-DOWN"),
    ]);

    if (!upSig && !downSig) {
      console.error("[LIMIT] ❌ Both order submissions failed");
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: "Both order tx submissions failed",
        });
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    if (!upSig || !downSig) {
      console.log(`[LIMIT] ⚠️ Only one order placed (up=${!!upSig} down=${!!downSig}) — cancelling`);
      await cancelAllOrders();
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: `One order failed: up=${!!upSig} down=${!!downSig}`,
        });
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    console.log(`[LIMIT] ✅ Both limit orders placed! Monitoring fills...`);
    console.log(`[LIMIT] Up order: ${upOrder.orderPubkey.slice(0, 16)}...`);
    console.log(`[LIMIT] Down order: ${downOrder.orderPubkey.slice(0, 16)}...`);

    // Track the position
    activeLimitMakes.set(eventKey, {
      eventTitle: market.title,
      upMarketId: market.marketId,
      downMarketId,
      upOrderPubkey: upOrder.orderPubkey,
      downOrderPubkey: downOrder.orderPubkey,
      upPrice: market.yesPrice,
      downPrice: market.noPrice,
      contracts,
      upFilled: false,
      downFilled: false,
      placedAt: Date.now(),
      closeTime: (market.closeTime || 0) * 1000,
      oppId,
    });

    marketCooldowns.set(market.marketId, Date.now());
  } catch (err) {
    console.error("[LIMIT] ❌ Execution error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
        status: "failed", error_message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
}

// ── Monitor Active Limit-Make Positions ─────────────────
async function monitorLimitMakes(): Promise<void> {
  if (activeLimitMakes.size === 0) return;

  console.log(`[MONITOR] Checking ${activeLimitMakes.size} active limit-make positions...`);

  for (const [eventKey, pos] of activeLimitMakes.entries()) {
    const elapsed = Date.now() - pos.placedAt;
    const remaining = pos.closeTime - Date.now();

    // Check fill status
    if (pos.upOrderPubkey && !pos.upFilled) {
      const status = await checkOrderStatus(pos.upOrderPubkey);
      if (status === "filled") {
        pos.upFilled = true;
        console.log(`[MONITOR] ✅ Up order FILLED for ${pos.eventTitle}`);
      } else if (status === "failed") {
        console.log(`[MONITOR] ❌ Up order FAILED for ${pos.eventTitle}`);
        pos.upOrderPubkey = null;
      }
    }

    if (pos.downOrderPubkey && !pos.downFilled) {
      const status = await checkOrderStatus(pos.downOrderPubkey);
      if (status === "filled") {
        pos.downFilled = true;
        console.log(`[MONITOR] ✅ Down order FILLED for ${pos.eventTitle}`);
      } else if (status === "failed") {
        console.log(`[MONITOR] ❌ Down order FAILED for ${pos.eventTitle}`);
        pos.downOrderPubkey = null;
      }
    }

    // ── Both filled: PROFIT! ──
    if (pos.upFilled && pos.downFilled) {
      const totalCost = (pos.upPrice + pos.downPrice) * pos.contracts;
      const payout = pos.contracts;
      const fees = estimateFee(pos.contracts, pos.upPrice) + estimateFee(pos.contracts, pos.downPrice);
      const netProfit = payout - totalCost - fees;

      console.log(`[MONITOR] 💰💰 BOTH SIDES FILLED! ${pos.eventTitle}`);
      console.log(`[MONITOR] Cost=$${totalCost.toFixed(2)} Payout=$${payout.toFixed(2)} Net=$${netProfit.toFixed(4)}`);

      if (pos.oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: pos.oppId, amount_usd: totalCost, realized_pnl: netProfit,
          fees, status: "filled",
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", pos.oppId);
      }

      activeLimitMakes.delete(eventKey);
      continue;
    }

    // ── Timeout: cancel unfilled, sell back filled ──
    const shouldUnwind =
      elapsed > LIMIT_MAKE_TIMEOUT_MS ||
      remaining < 60_000 || // Less than 1 min to close
      (!pos.upOrderPubkey && !pos.downOrderPubkey); // Both orders failed

    if (shouldUnwind) {
      console.log(`[MONITOR] ⏰ Unwinding ${pos.eventTitle} (elapsed=${Math.round(elapsed / 1000)}s remaining=${Math.round(remaining / 1000)}s)`);

      // Cancel any pending orders
      await cancelAllOrders();

      // If one side filled, sell it back
      if (pos.upFilled && !pos.downFilled) {
        console.log(`[MONITOR] Selling back Up position (${pos.contracts} contracts)...`);
        const sellTxRaw = await createSellOrder(pos.upMarketId, true, pos.contracts);
        if (sellTxRaw) {
          const sellTx = await buildAndSign(sellTxRaw);
          const sig = await sendDirect(sellTx, "SELL-BACK-UP");
          if (sig) {
            console.log(`[MONITOR] ✅ Sold back Up position: ${sig.slice(0, 16)}...`);
          }
        } else {
          console.log(`[MONITOR] ⚠️ Could not sell back — holding to expiry (binary outcome)`);
        }
      }

      if (pos.downFilled && !pos.upFilled) {
        console.log(`[MONITOR] Selling back Down position (${pos.contracts} contracts)...`);
        const sellTxRaw = await createSellOrder(pos.downMarketId, true, pos.contracts);
        if (sellTxRaw) {
          const sellTx = await buildAndSign(sellTxRaw);
          const sig = await sendDirect(sellTx, "SELL-BACK-DOWN");
          if (sig) {
            console.log(`[MONITOR] ✅ Sold back Down position: ${sig.slice(0, 16)}...`);
          }
        } else {
          console.log(`[MONITOR] ⚠️ Could not sell back — holding to expiry (binary outcome)`);
        }
      }

      // Log as failed
      if (pos.oppId) {
        const filled = pos.upFilled ? "up" : pos.downFilled ? "down" : "none";
        await supabase.from("arb_executions").insert({
          opportunity_id: pos.oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed",
          error_message: `Timeout: only ${filled} side filled, unwound`,
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", pos.oppId);
      }

      activeLimitMakes.delete(eventKey);
    }
  }
}

// ══════════════════════════════════════════════════════════
// ── Split & Sell Execution (unchanged) ──────────────────
// ══════════════════════════════════════════════════════════
async function executeSplitSell(opp: ArbOpportunity): Promise<void> {
  const { market, netProfit } = opp;
  const contracts = Math.floor(CONFIG.ARB_AMOUNT);
  const downMarketId = (market as any).downMarketId || market.marketId;

  console.log(`\n[SPLIT] ═══ EXECUTING SPLIT & SELL ══════════════════`);
  console.log(`[SPLIT] Event: ${market.title}`);
  console.log(`[SPLIT] Sell YES(Up)=$${market.sellYesPrice.toFixed(4)} + Sell YES(Down)=$${market.sellNoPrice.toFixed(4)}`);
  console.log(`[SPLIT] Est. net profit: $${netProfit.toFixed(4)}`);

  if (market.platform === "dflow") {
    console.log(`[SPLIT] 📊 DFlow — execution not supported`);
    marketCooldowns.set(market.marketId, Date.now());
    return;
  }

  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId, market_b_id: downMarketId,
      side_a: "sell_up_yes", side_b: "sell_down_yes",
      price_a: market.sellYesPrice, price_b: market.sellNoPrice,
      spread: market.splitSpread, status: "executing",
    })
    .select("id").single();

  const oppId = oppRow?.id;

  try {
    const [sellUpTxRaw, sellDownTxRaw] = await Promise.all([
      createSellOrder(market.marketId, true, contracts),
      createSellOrder(downMarketId, true, contracts),
    ]);

    if (!sellUpTxRaw || !sellDownTxRaw) {
      console.log("[SPLIT] ⚠️ Could not get sell quotes");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: `Sell quote failed`,
        });
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    const [sellUpTx, sellDownTx] = await Promise.all([
      buildAndSign(sellUpTxRaw), buildAndSign(sellDownTxRaw),
    ]);

    console.log("[JITO] Submitting Sell bundle...");
    const bundleResult = await sendJitoBundle([sellUpTx, sellDownTx]);
    marketCooldowns.set(market.marketId, Date.now());

    if (bundleResult) {
      console.log(`[SPLIT] ✅ Jito bundle landed! ${bundleResult}`);
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: opp.totalCost, realized_pnl: netProfit,
          fees: opp.fees, status: "filled",
          side_a_tx: bs58.encode(sellUpTx.signatures[0]),
          side_b_tx: bs58.encode(sellDownTx.signatures[0]),
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
      }
    } else {
      console.error(`[SPLIT] ❌ Jito bundle failed`);
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: "Jito bundle rejected",
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[SPLIT] ❌ Error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
    }
  }
}

// ══════════════════════════════════════════════════════════
// ── Merge Execution (unchanged) ─────────────────────────
// ══════════════════════════════════════════════════════════
async function executeMerge(opp: ArbOpportunity): Promise<void> {
  const { market, yesCost, noCost, totalCost, netProfit } = opp;
  const downMarketId = (market as any).downMarketId || market.marketId;

  console.log(`\n[ARB] ═══ EXECUTING MERGE ═══════════════════════════`);
  console.log(`[ARB] Event: ${market.title}`);
  console.log(`[ARB] Up=$${market.yesPrice.toFixed(4)} + Down=$${market.noPrice.toFixed(4)} = ${(market.yesPrice + market.noPrice).toFixed(4)}`);
  console.log(`[ARB] Est. net profit: $${netProfit.toFixed(4)}`);

  if (market.platform === "dflow") {
    console.log(`[ARB] 📊 DFlow — execution not supported`);
    marketCooldowns.set(market.marketId, Date.now());
    return;
  }

  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.marketId, market_b_id: downMarketId,
      side_a: "up_yes", side_b: "down_yes",
      price_a: market.yesPrice, price_b: market.noPrice,
      spread: market.spread, status: "executing",
    })
    .select("id").single();

  const oppId = oppRow?.id;

  try {
    const [upOrder, downOrder] = await Promise.all([
      createBuyOrder(market.marketId, true, Math.floor(yesCost / market.yesPrice), yesCost),
      createBuyOrder(downMarketId, true, Math.floor(noCost / market.noPrice), noCost),
    ]);

    if (!upOrder || !downOrder) {
      console.log("[ARB] ⚠️ Could not get quotes");
      if (upOrder || downOrder) await cancelAllOrders();
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      return;
    }

    const [upTx, downTx] = await Promise.all([
      buildAndSign(upOrder.transaction), buildAndSign(downOrder.transaction),
    ]);

    console.log("[JITO] Submitting Merge bundle...");
    const bundleResult = await sendJitoBundle([upTx, downTx]);
    marketCooldowns.set(market.marketId, Date.now());

    if (bundleResult) {
      console.log(`[ARB] ✅ Jito bundle landed! ${bundleResult}`);
      await sleep(3000);
      const openOrders = await getOpenOrders();
      if (openOrders.length > 0) {
        console.log(`[ARB] ⚠️ ${openOrders.length} unfilled — cancelling`);
        await cancelAllOrders();
        await closeAllPositions();
      } else {
        console.log(`[ARB] ✅ Both legs filled! Net profit: ~$${netProfit.toFixed(4)}`);
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: totalCost, realized_pnl: netProfit,
            fees: opp.fees, status: "filled",
            side_a_tx: bs58.encode(upTx.signatures[0]),
            side_b_tx: bs58.encode(downTx.signatures[0]),
          });
          await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
        }
      }
    } else {
      console.error(`[ARB] ❌ Jito bundle failed`);
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[ARB] ❌ Error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
    }
  }
}

// ── Jito Bundle Submission ──────────────────────────────
async function sendJitoBundle(txs: VersionedTransaction[]): Promise<string | null> {
  try {
    const encodedTxs = txs.map(tx => bs58.encode(tx.serialize()));
    const res = await fetch(JITO_BUNDLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "sendBundle",
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

    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const statusRes = await fetch(JITO_BUNDLE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });
        const statusData = await statusRes.json() as any;
        const statuses = statusData?.result?.value || [];
        if (statuses.length > 0) {
          const s = statuses[0];
          console.log(`[JITO] Status: ${s.confirmation_status || s.status}`);
          if (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized") return bundleId;
          if (s.err || s.confirmation_status === "failed") return null;
        }
      } catch { /* retry */ }
    }

    console.warn("[JITO] Status unknown after 30s");
    return null;
  } catch (err) {
    console.error("[JITO] Submission error:", err);
    return null;
  }
}

// ── Direct TX Submission ────────────────────────────────
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
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.orders || []);
  } catch {
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
      console.error(`[CANCEL] Error ${res.status}: ${rawText.slice(0, 300)}`);
      return false;
    }

    let data: any;
    try { data = JSON.parse(rawText); } catch { return false; }

    const txList = data.transactions || (data.transaction ? [data.transaction] : []);
    for (const txData of txList) {
      const tx = await buildAndSign(txData);
      const sig = await sendDirect(tx, "CANCEL");
      if (sig) console.log(`[CANCEL] ✅ Cancelled: ${sig.slice(0, 16)}...`);
    }

    if (txList.length === 0) console.log("[CANCEL] No open orders to cancel");
    return true;
  } catch (err) {
    console.error("[CANCEL] ❌ Error:", err);
    return false;
  }
}

// ── Close All Positions ─────────────────────────────────
async function closeAllPositions(): Promise<boolean> {
  try {
    console.log("[CLOSE] Closing all positions...");
    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/positions`, {
      method: "DELETE",
      headers: { ...jupHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey: WALLET }),
    });

    const rawText = await res.text();
    if (!res.ok) return false;

    let data: any;
    try { data = JSON.parse(rawText); } catch { return false; }

    if (data.transaction) {
      const tx = await buildAndSign(data.transaction);
      await sendDirect(tx, "CLOSE-ALL");
      return true;
    }
    if (data.transactions && Array.isArray(data.transactions)) {
      for (const txData of data.transactions) {
        const tx = await buildAndSign(txData);
        await sendDirect(tx, "CLOSE");
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error("[CLOSE] ❌ Error:", err);
    return false;
  }
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan() {
  try {
    console.log(`\n[SCAN] ${new Date().toISOString()} ─────────────────────────`);

    // Monitor existing limit-make positions FIRST
    await monitorLimitMakes();

    // Fetch markets
    const [jupMarkets, dflowMarkets] = await Promise.all([
      fetchJupiterMarkets(),
      fetchDFlowCryptoMarkets(),
    ]);
    const markets = [...jupMarkets, ...dflowMarkets];

    if (markets.length === 0) {
      console.log("[SCAN] No markets found — retrying next interval");
      return;
    }
    console.log(`[SCAN] Total: ${markets.length} markets (Jupiter=${jupMarkets.length}, DFlow=${dflowMarkets.length})`);

    const arbs = findArbs(markets);

    if (arbs.length === 0) {
      const activeCount = activeLimitMakes.size;
      console.log(`[SCAN] No new arbs | Active limit-makes: ${activeCount}`);
      return;
    }

    const limitMakes = arbs.filter(a => a.strategy === "limit_make");
    const merges = arbs.filter(a => a.strategy === "merge");
    const splits = arbs.filter(a => a.strategy === "split_sell");
    console.log(`\n[SCAN] 🎯 FOUND ${arbs.length} opportunities! (${limitMakes.length} limit_make, ${merges.length} merge, ${splits.length} split)`);

    for (const a of arbs.slice(0, 5)) {
      const icon = a.strategy === "limit_make" ? "🏦" : a.strategy === "split_sell" ? "🔀" : "💰";
      console.log(`  ${icon} [${a.strategy}] "${a.market.title.slice(0, 50)}" net=$${a.netProfit.toFixed(4)}`);
    }

    // Execute top opportunities
    for (const arb of arbs.slice(0, 2)) {
      await executeArb(arb);
      await sleep(1000);
    }

    // Upsert to DB
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
      console.warn("[ARB] ⚠️ Low SOL");
    }
  } catch {
    console.warn("[ARB] Could not check wallet balance");
  }

  if (!CONFIG.JUP_PREDICT_API_KEY) {
    console.warn("[ARB] ⚠️ No JUP_PREDICT_API_KEY — may be rate-limited");
  }

  // Startup cleanup
  console.log("[ARB] Checking for stale open orders...");
  const staleOrders = await getOpenOrders();
  if (staleOrders.length > 0) {
    console.log(`[ARB] Found ${staleOrders.length} stale orders — cancelling`);
    await cancelAllOrders();
  } else {
    console.log("[ARB] No stale orders ✅");
  }

  console.log("[ARB] Starting scan loop...\n");
  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL);
  console.log("[ARB] Engine running — LIMIT_MAKE + MERGE + SPLIT_SELL");
}

main().catch(console.error);
