/**
 * RICKY TRADES — Jupiter Predict Arb Engine v3 (Atomic Only)
 *
 * Strategies (100% atomic via Jito bundles — all-or-nothing):
 *   1. MERGE: buy YES(Up) + YES(Down) when askUp + askDown < $1 - fees
 *   2. SPLIT_SELL: sell YES(Up) + YES(Down) when bidUp + bidDown > $1 + fees
 *
 * Key features:
 *   - Fast scan (500ms) to catch transient mispricings
 *   - New-window detection: aggressively scans when a 5-min market just opened
 *   - Zero leg risk: Jito bundles guarantee both legs land or neither does
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
const COOLDOWN_MS = 60 * 1000; // 1 min cooldown after attempt

// Jito bundle endpoints (mainnet)
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Fast scan interval (500ms for catching transient mispricings)
const FAST_SCAN_MS = 500;
// Normal scan when no new windows detected
const NORMAL_SCAN_MS = Math.max(CONFIG.SCAN_INTERVAL, 2000);

// Track best spreads seen per scan for logging
let scanCount = 0;
let bestMergeSpreadSeen = -Infinity;
let bestSplitSpreadSeen = -Infinity;

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
console.log("  RICKY TRADES — Jupiter Predict Arb v3 (Atomic Only)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[ARB] Wallet: ${WALLET}`);
console.log(`[ARB] Amount per trade: $${CONFIG.ARB_AMOUNT}`);
console.log(`[ARB] Min spread: ${(CONFIG.MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[ARB] Fast scan: ${FAST_SCAN_MS}ms | Normal scan: ${NORMAL_SCAN_MS}ms`);
console.log(`[ARB] Jupiter API: ${CONFIG.JUP_PREDICT_API}`);
console.log(`[ARB] Strategies: MERGE + SPLIT_SELL (atomic Jito bundles only)`);
console.log(`[ARB] Zero leg risk — both sides execute or neither does`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface JupMarket {
  marketId: string;
  eventId: string;
  title: string;
  status: string;
  yesPrice: number;  // buyYes (ask) on Up
  noPrice: number;   // buyYes (ask) on Down
  spread: number;    // 1 - (askUp + askDown) — positive = merge opportunity
  category: string;
  endDate: string | null;
  volume: number;
  platform: "jupiter_predict" | "dflow";
  closeTime?: number | null;
  openTime?: number | null;
  sellYesPrice: number;  // sellYes (bid) on Up
  sellNoPrice: number;   // sellYes (bid) on Down
  splitSpread: number;   // (bidUp + bidDown) - 1 — positive = split opportunity
  upBid: number;
  downBid: number;
  upAsk: number;
  downAsk: number;
  isNewWindow?: boolean; // Market opened < 30s ago
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
const TIMED_COINS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype", "sui", "avax", "ada", "link"];
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
            const openTime = Number(upMarket.openTime || upMarket.metadata?.openTime || 0);
            const eventTitle = event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`;

            const totalAsk = upBuyYes + downBuyYes;
            const totalBid = upSellYes + downSellYes;
            const mergeSpread = 1 - totalAsk;  // positive = profitable merge
            const splitSpread = totalBid - 1;   // positive = profitable split

            // Detect new windows (opened < 30s ago)
            const isNewWindow = openTime > 0 && (now - openTime) < 30;

            const market: JupMarket = {
              marketId: upMarket.marketId,
              eventId: event.eventId || "",
              title: eventTitle,
              status: "open",
              yesPrice: upBuyYes,
              noPrice: downBuyYes,
              spread: mergeSpread,
              category: "crypto",
              endDate: toIsoFromUnix(closeTime),
              volume: Number(upMarket.pricing?.volume || 0) + Number(downMarket.pricing?.volume || 0),
              platform: "jupiter_predict",
              closeTime: closeTime || null,
              openTime: openTime || null,
              sellYesPrice: upSellYes,
              sellNoPrice: downSellYes,
              splitSpread,
              upBid: upSellYes,
              downBid: downSellYes,
              upAsk: upBuyYes,
              downAsk: downBuyYes,
              isNewWindow,
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

  const mergeCandidates = allMarkets.filter(m => m.spread > 0);
  const splitCandidates = allMarkets.filter(m => m.splitSpread > 0);
  const newWindows = allMarkets.filter(m => m.isNewWindow);

  // Only log full details every 10 scans to reduce noise
  const verbose = scanCount % 10 === 0;

  if (verbose || mergeCandidates.length > 0 || splitCandidates.length > 0 || newWindows.length > 0) {
    console.log(
      `[JUP] Markets: ${allMarkets.length} | Merge: ${mergeCandidates.length} | Split: ${splitCandidates.length} | New windows: ${newWindows.length}`
    );
  }

  // Track best spreads
  for (const m of allMarkets) {
    if (m.spread > bestMergeSpreadSeen) bestMergeSpreadSeen = m.spread;
    if (m.splitSpread > bestSplitSpreadSeen) bestSplitSpreadSeen = m.splitSpread;
  }

  // Log new windows (these are our best chance for mispricings)
  for (const m of newWindows) {
    const age = Math.round(((Date.now() / 1000) - (m.openTime || 0)));
    console.log(
      `  🆕 NEW WINDOW (${age}s old) ${m.title.slice(0, 50)} | ` +
      `ask=$${m.upAsk.toFixed(3)}+$${m.downAsk.toFixed(3)}=${(m.upAsk + m.downAsk).toFixed(4)} ` +
      `bid=$${m.upBid.toFixed(3)}+$${m.downBid.toFixed(3)}=${(m.upBid + m.downBid).toFixed(4)} ` +
      `merge=${(m.spread * 100).toFixed(2)}% split=${(m.splitSpread * 100).toFixed(2)}%`
    );
  }

  // Log top 3 closest to profitable (only on verbose scans)
  if (verbose && mergeCandidates.length === 0 && splitCandidates.length === 0) {
    for (const m of allMarkets.slice(0, 3)) {
      const remaining = ((m.closeTime || 0) - Date.now() / 1000);
      console.log(
        `  📊 ${m.title.slice(0, 50)} | ` +
        `ask=${(m.upAsk + m.downAsk).toFixed(4)} bid=${(m.upBid + m.downBid).toFixed(4)} ` +
        `merge=${(m.spread * 100).toFixed(2)}% split=${(m.splitSpread * 100).toFixed(2)}% rem=${Math.round(remaining / 60)}m`
      );
    }
    console.log(`  📈 Best merge seen: ${(bestMergeSpreadSeen * 100).toFixed(3)}% | Best split seen: ${(bestSplitSpreadSeen * 100).toFixed(3)}%`);
  }

  return allMarkets;
}

// ── DFlow Markets ───────────────────────────────────────
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
    const verbose = scanCount % 10 === 0;
    if (verbose) {
      console.log(`[DFLOW] Timed crypto markets: ${result.length} | Positive spread: ${result.filter(m => m.spread > 0).length}`);
    }
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

// ── Find Opportunities (atomic only) ────────────────────
function findArbs(markets: JupMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    const lastAttempt = marketCooldowns.get(market.marketId);
    if (lastAttempt && (Date.now() - lastAttempt) < COOLDOWN_MS) continue;

    // Need at least 1 min remaining
    const remaining = ((market.closeTime || 0) - Date.now() / 1000);
    if (remaining < 60) continue;

    // ── Strategy 1: MERGE (buy both sides, atomic) ──────
    // Profitable when: askUp + askDown < $1 - fees
    if (market.spread > 0) {
      const amount = CONFIG.ARB_AMOUNT;
      const yesCost = market.yesPrice * amount;
      const noCost = market.noPrice * amount;
      const totalCost = yesCost + noCost;
      const payout = amount; // $1 per contract at settlement
      const platformFee = totalCost * 0.005;
      const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD;
      const fees = platformFee + txFeeUsd;
      const grossProfit = payout - totalCost;
      const netProfit = grossProfit - fees;

      if (netProfit > 0) {
        opps.push({
          market, yesCost, noCost, totalCost, payout, grossProfit, fees, netProfit,
          strategy: "merge",
        });
      }
    }

    // ── Strategy 2: SPLIT_SELL (sell both sides, atomic) ─
    // Profitable when: bidUp + bidDown > $1 + fees
    if (market.splitSpread > 0 && market.sellYesPrice > 0 && market.sellNoPrice > 0) {
      const amount = CONFIG.ARB_AMOUNT;
      const sellUpRevenue = market.sellYesPrice * amount;
      const sellDownRevenue = market.sellNoPrice * amount;
      const totalRevenue = sellUpRevenue + sellDownRevenue;
      const collateral = amount; // $1 per contract to split
      const platformFee = totalRevenue * 0.005;
      const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD;
      const fees = platformFee + txFeeUsd;
      const grossProfit = totalRevenue - collateral;
      const netProfit = grossProfit - fees;

      if (netProfit > 0) {
        opps.push({
          market, yesCost: sellUpRevenue, noCost: sellDownRevenue,
          totalCost: collateral, payout: totalRevenue, grossProfit, fees, netProfit,
          strategy: "split_sell",
        });
      }
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute Arb ─────────────────────────────────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  if (opp.strategy === "split_sell") return executeSplitSell(opp);
  return executeMerge(opp);
}

// ══════════════════════════════════════════════════════════
// ── Split & Sell Execution (atomic Jito bundle) ─────────
// ══════════════════════════════════════════════════════════
async function executeSplitSell(opp: ArbOpportunity): Promise<void> {
  const { market, netProfit } = opp;
  const contracts = Math.floor(CONFIG.ARB_AMOUNT);
  const downMarketId = (market as any).downMarketId || market.marketId;

  console.log(`\n[SPLIT] ═══ EXECUTING SPLIT & SELL ══════════════════`);
  console.log(`[SPLIT] Event: ${market.title}`);
  console.log(`[SPLIT] Sell YES(Up)=$${market.sellYesPrice.toFixed(4)} + Sell YES(Down)=$${market.sellNoPrice.toFixed(4)}`);
  console.log(`[SPLIT] Sum=${(market.sellYesPrice + market.sellNoPrice).toFixed(4)} | Est. net profit: $${netProfit.toFixed(4)}`);

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
      console.log("[SPLIT] ⚠️ Could not get sell quotes — aborting (zero risk)");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: "Sell quote failed",
        });
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    const [sellUpTx, sellDownTx] = await Promise.all([
      buildAndSign(sellUpTxRaw), buildAndSign(sellDownTxRaw),
    ]);

    console.log("[JITO] Submitting atomic Sell bundle (both or neither)...");
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
      console.error(`[SPLIT] ❌ Jito bundle failed — no capital at risk`);
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
// ── Merge Execution (atomic Jito bundle) ────────────────
// ══════════════════════════════════════════════════════════
async function executeMerge(opp: ArbOpportunity): Promise<void> {
  const { market, yesCost, noCost, totalCost, netProfit } = opp;
  const downMarketId = (market as any).downMarketId || market.marketId;

  console.log(`\n[ARB] ═══ EXECUTING MERGE ═══════════════════════════`);
  console.log(`[ARB] Event: ${market.title}`);
  console.log(`[ARB] Buy Up=$${market.yesPrice.toFixed(4)} + Down=$${market.noPrice.toFixed(4)} = ${(market.yesPrice + market.noPrice).toFixed(4)}`);
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
    const contracts = Math.floor(CONFIG.ARB_AMOUNT / Math.max(market.yesPrice, 0.01));
    const [upOrder, downOrder] = await Promise.all([
      createBuyOrder(market.marketId, true, contracts, yesCost),
      createBuyOrder(downMarketId, true, contracts, noCost),
    ]);

    if (!upOrder || !downOrder) {
      console.log("[ARB] ⚠️ Could not get quotes — aborting (zero risk)");
      if (upOrder || downOrder) await cancelAllOrders();
      if (oppId) {
        await supabase.from("arb_opportunities").update({ status: "expired" }).eq("id", oppId);
      }
      marketCooldowns.set(market.marketId, Date.now());
      return;
    }

    const [upTx, downTx] = await Promise.all([
      buildAndSign(upOrder.transaction), buildAndSign(downOrder.transaction),
    ]);

    console.log("[JITO] Submitting atomic Merge bundle (both or neither)...");
    const bundleResult = await sendJitoBundle([upTx, downTx]);
    marketCooldowns.set(market.marketId, Date.now());

    if (bundleResult) {
      console.log(`[ARB] ✅ Jito bundle landed! ${bundleResult}`);
      // Verify fills
      await sleep(3000);
      const openOrders = await getOpenOrders();
      if (openOrders.length > 0) {
        console.log(`[ARB] ⚠️ ${openOrders.length} unfilled orders — cancelling + closing`);
        await cancelAllOrders();
        await closeAllPositions();
        if (oppId) {
          await supabase.from("arb_executions").insert({
            opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
            status: "failed", error_message: "Orders placed but not filled — unwound",
          });
          await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
        }
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
      console.error(`[ARB] ❌ Jito bundle failed — no capital at risk`);
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
async function runScan(): Promise<boolean> {
  let hasNewWindows = false;
  try {
    scanCount++;
    const verbose = scanCount % 10 === 0;
    if (verbose) {
      console.log(`\n[SCAN] #${scanCount} ${new Date().toISOString()} ─────────────────────────`);
    }

    const [jupMarkets, dflowMarkets] = await Promise.all([
      fetchJupiterMarkets(),
      fetchDFlowCryptoMarkets(),
    ]);
    const markets = [...jupMarkets, ...dflowMarkets];

    if (markets.length === 0) {
      if (verbose) console.log("[SCAN] No markets found — retrying");
      return false;
    }

    hasNewWindows = markets.some(m => m.isNewWindow);

    if (verbose) {
      console.log(`[SCAN] Total: ${markets.length} markets (Jupiter=${jupMarkets.length}, DFlow=${dflowMarkets.length})`);
    }

    const arbs = findArbs(markets);

    if (arbs.length === 0) {
      if (verbose) console.log("[SCAN] No arbs above threshold");
      return hasNewWindows;
    }

    const merges = arbs.filter(a => a.strategy === "merge");
    const splits = arbs.filter(a => a.strategy === "split_sell");
    console.log(`\n[SCAN] 🎯 FOUND ${arbs.length} opportunities! (${merges.length} merge, ${splits.length} split)`);

    for (const a of arbs.slice(0, 5)) {
      const icon = a.strategy === "split_sell" ? "🔀" : "💰";
      console.log(`  ${icon} [${a.strategy}] "${a.market.title.slice(0, 50)}" net=$${a.netProfit.toFixed(4)}`);
    }

    // Execute top opportunity
    for (const arb of arbs.slice(0, 2)) {
      await executeArb(arb);
      await sleep(500);
    }

    // Upsert to DB (only every 10 scans to save DB writes)
    if (verbose) {
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
    }
  } catch (err) {
    console.error("[SCAN] Error:", err);
  }
  return hasNewWindows;
}

// ── Adaptive Scan Loop ──────────────────────────────────
// Fast (500ms) when new market windows detected, normal (2s) otherwise
async function scanLoop() {
  while (true) {
    const hasNewWindows = await runScan();
    const delay = hasNewWindows ? FAST_SCAN_MS : NORMAL_SCAN_MS;
    await sleep(delay);
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

  console.log("[ARB] Starting adaptive scan loop (500ms fast / 2s normal)...\n");
  scanLoop();
}

main().catch(console.error);
