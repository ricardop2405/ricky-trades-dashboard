/**
 * RICKY TRADES — Drift BET ↔ Jupiter Predict Cross-Platform Arb Engine
 *
 * Strategy: Atomic cross-platform prediction market arbitrage via Jito bundles.
 *
 * How it works:
 *   1. Fetch active BET markets from Drift (perp markets with contract_type=Prediction)
 *   2. Fetch active timed crypto markets from Jupiter Predict
 *   3. Fuzzy-match overlapping events (e.g., "BTC UP 15min" on both platforms)
 *   4. Detect sum-to-1 mispricings across platforms:
 *      - CROSS_MERGE: buy YES on cheaper platform + NO on the other when sum < $1
 *      - CROSS_SPLIT: sell YES on one + NO on the other when sum > $1
 *   5. Execute atomically via Jito bundle (zero leg risk)
 *
 * Required: @drift-labs/sdk, Helius RPC, Solana wallet
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Setup ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

// Jito
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Drift Data API
const DRIFT_DATA_API = "https://data.api.drift.trade";

// Jupiter Predict API
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";
const TIMED_COINS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "sui", "avax", "ada", "link"];
const TIMED_INTERVALS = ["5m", "15m"];

// Scan settings
const SCAN_INTERVAL_MS = parseInt(process.env.DRIFT_SCAN_INTERVAL_MS || "3000");
const MIN_CROSS_SPREAD = parseFloat(process.env.DRIFT_MIN_SPREAD || "0.015");
const TRADE_SIZE_USD = parseFloat(process.env.DRIFT_TRADE_SIZE_USD || "5");
const DRY_RUN = process.env.DRIFT_DRY_RUN !== "false"; // default: dry run

// Cooldowns
const marketCooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;
let scanCount = 0;

// Proxy
const PROXY_URL = process.env.PROXY_URL || "";
let proxyAgent: any = null;
if (PROXY_URL) {
  if (PROXY_URL.startsWith("socks")) proxyAgent = new SocksProxyAgent(PROXY_URL);
  else proxyAgent = new HttpsProxyAgent(PROXY_URL);
}

async function jupFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!proxyAgent) return fetch(url, init);
  const nodeFetch = (await import("node-fetch")).default;
  return nodeFetch(url, { ...init, agent: proxyAgent } as any) as unknown as Response;
}

function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.JUP_PREDICT_API_KEY) {
    h["x-api-key"] = CONFIG.JUP_PREDICT_API_KEY;
    h["Authorization"] = `Bearer ${CONFIG.JUP_PREDICT_API_KEY}`;
  }
  return h;
}

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Drift BET ↔ Jupiter Predict Cross-Arb");
console.log("═══════════════════════════════════════════════════════");
console.log(`[DRIFT-JUP] Wallet: ${WALLET}`);
console.log(`[DRIFT-JUP] Trade size: $${TRADE_SIZE_USD}`);
console.log(`[DRIFT-JUP] Min cross spread: ${(MIN_CROSS_SPREAD * 100).toFixed(1)}%`);
console.log(`[DRIFT-JUP] Scan interval: ${SCAN_INTERVAL_MS}ms`);
console.log(`[DRIFT-JUP] Dry run: ${DRY_RUN}`);
console.log(`[DRIFT-JUP] Proxy: ${PROXY_URL ? "active" : "none"}`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface CrossMarket {
  platform: "drift" | "jupiter_predict";
  marketId: string;
  symbol: string;       // normalized: BTC, ETH, SOL, etc.
  direction: "up" | "down" | "yes" | "no";
  bidPrice: number;     // best bid (sell price)
  askPrice: number;     // best ask (buy price)
  marketIndex?: number; // Drift perp market index
  closeTime?: number;
  title: string;
}

interface CrossArbOpportunity {
  type: "cross_merge" | "cross_split";
  marketA: CrossMarket; // Platform A leg
  marketB: CrossMarket; // Platform B leg
  spread: number;       // Profit margin (positive = profitable)
  estProfit: number;    // Estimated USD profit
}

// ── Drift BET Market Discovery ──────────────────────────
// Uses the Drift Data API to find active BET prediction markets
async function fetchDriftBETMarkets(): Promise<CrossMarket[]> {
  const markets: CrossMarket[] = [];
  try {
    // Fetch all perp market stats to find BET markets
    const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
    if (!res.ok) {
      console.error(`[DRIFT] Stats API error: ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const perpMarkets = data.perpMarkets || data.perp || data || [];
    const betMarkets = (Array.isArray(perpMarkets) ? perpMarkets : []).filter((m: any) => {
      const symbol = (m.symbol || m.marketName || "").toUpperCase();
      // BET markets have specific naming patterns like "BTC-UP-5MIN", "ETH-DOWN-15MIN"
      return (
        symbol.includes("-BET") ||
        symbol.includes("-UP") ||
        symbol.includes("-DOWN") ||
        symbol.includes("PREDICT") ||
        (m.contractType === "prediction" || m.contract_type === "prediction")
      );
    });

    for (const m of betMarkets) {
      const symbol = (m.symbol || m.marketName || "").toUpperCase();
      
      // Extract the base asset (BTC, ETH, SOL, etc.)
      let baseAsset = "";
      for (const coin of TIMED_COINS) {
        if (symbol.includes(coin.toUpperCase())) {
          baseAsset = coin.toUpperCase();
          break;
        }
      }
      if (!baseAsset) continue;

      // Determine direction
      let direction: "up" | "down" | "yes" | "no" = "yes";
      if (symbol.includes("UP")) direction = "up";
      else if (symbol.includes("DOWN")) direction = "down";
      else if (symbol.includes("NO")) direction = "no";

      const bid = Number(m.lastPrice || m.markPrice || 0);
      const ask = bid; // Drift uses single mark price; real bid/ask from orderbook

      markets.push({
        platform: "drift",
        marketId: symbol,
        symbol: baseAsset,
        direction,
        bidPrice: bid,
        askPrice: ask,
        marketIndex: Number(m.marketIndex ?? m.market_index ?? 0),
        closeTime: Number(m.expiryTs || m.expiry_ts || 0) || undefined,
        title: symbol,
      });
    }

    // Also try the DLOB (Decentralized Limit Order Book) for real bid/ask
    if (markets.length > 0) {
      try {
        for (const market of markets) {
          if (market.marketIndex === undefined) continue;
          const obRes = await fetch(
            `${DRIFT_DATA_API}/dlob/l2?marketIndex=${market.marketIndex}&marketType=perp&depth=1`
          );
          if (obRes.ok) {
            const ob = await obRes.json() as any;
            const bestBid = Number(ob.bids?.[0]?.price || 0) / 1e6; // PRICE_PRECISION = 1e6
            const bestAsk = Number(ob.asks?.[0]?.price || 0) / 1e6;
            if (bestBid > 0) market.bidPrice = bestBid;
            if (bestAsk > 0) market.askPrice = bestAsk;
          }
        }
      } catch (err) {
        console.error("[DRIFT] DLOB fetch error:", err);
      }
    }

    const verbose = scanCount % 10 === 0;
    if (verbose) {
      console.log(`[DRIFT] BET markets found: ${markets.length}`);
      for (const m of markets.slice(0, 5)) {
        console.log(`  📊 ${m.title} dir=${m.direction} bid=$${m.bidPrice.toFixed(4)} ask=$${m.askPrice.toFixed(4)}`);
      }
    }
  } catch (err) {
    console.error("[DRIFT] Fetch error:", err);
  }
  return markets;
}

// ── Jupiter Predict Market Fetch ────────────────────────
async function fetchJupiterCrossMarkets(): Promise<CrossMarket[]> {
  const markets: CrossMarket[] = [];
  const fetches: Promise<void>[] = [];

  for (const coin of TIMED_COINS) {
    for (const interval of TIMED_INTERVALS) {
      fetches.push((async () => {
        try {
          const url = `${JUP_TIMED_API}?subcategory=${coin}&tags=${interval}`;
          const res = await jupFetch(url, { headers: jupHeaders() });
          if (!res.ok) return;

          const data = await res.json() as any;
          const events = Array.isArray(data) ? data : data.data || data.events || [];
          const now = Date.now() / 1000;

          for (const event of events) {
            for (const m of (event.markets || [])) {
              if (m.status !== "open") continue;
              const closeTime = Number(m.closeTime || m.metadata?.closeTime || 0);
              if (closeTime && closeTime < now) continue;

              const title = (m.metadata?.title || m.title || "").toLowerCase();
              let direction: "up" | "down" = "up";
              if (title.includes("down")) direction = "down";

              const buyYes = Number(m.pricing?.buyYesPriceUsd || 0) / 1_000_000;
              const sellYes = Number(m.pricing?.sellYesPriceUsd || 0) / 1_000_000;
              if (buyYes <= 0) continue;

              markets.push({
                platform: "jupiter_predict",
                marketId: m.marketId,
                symbol: coin.toUpperCase(),
                direction,
                bidPrice: sellYes,
                askPrice: buyYes,
                closeTime: closeTime || undefined,
                title: m.metadata?.title || m.title || `${coin} ${interval} ${direction}`,
              });
            }
          }
        } catch {}
      })());
    }
  }

  await Promise.all(fetches);

  const verbose = scanCount % 10 === 0;
  if (verbose) {
    console.log(`[JUP] Cross markets found: ${markets.length}`);
  }
  return markets;
}

// ── Cross-Platform Matching ─────────────────────────────
function findCrossArbs(
  driftMarkets: CrossMarket[],
  jupMarkets: CrossMarket[]
): CrossArbOpportunity[] {
  const opps: CrossArbOpportunity[] = [];

  // Group by symbol
  const driftBySymbol = new Map<string, CrossMarket[]>();
  for (const m of driftMarkets) {
    const arr = driftBySymbol.get(m.symbol) || [];
    arr.push(m);
    driftBySymbol.set(m.symbol, arr);
  }

  const jupBySymbol = new Map<string, CrossMarket[]>();
  for (const m of jupMarkets) {
    const arr = jupBySymbol.get(m.symbol) || [];
    arr.push(m);
    jupBySymbol.set(m.symbol, arr);
  }

  for (const [symbol, driftMkts] of driftBySymbol) {
    const jupMkts = jupBySymbol.get(symbol);
    if (!jupMkts || jupMkts.length === 0) continue;

    // For each Drift market, find cross-platform arb with Jupiter
    for (const driftMkt of driftMkts) {
      const cooldownKey = `${driftMkt.marketId}-cross`;
      const lastAttempt = marketCooldowns.get(cooldownKey);
      if (lastAttempt && (Date.now() - lastAttempt) < COOLDOWN_MS) continue;

      for (const jupMkt of jupMkts) {
        // Strategy: Buy on cheaper, hedged against the other
        // For "up" markets: check Drift UP ask + Jupiter DOWN ask < 1
        // For complementary pairs: check opposite directions sum < 1

        const isComplement = (
          (driftMkt.direction === "up" && jupMkt.direction === "down") ||
          (driftMkt.direction === "down" && jupMkt.direction === "up") ||
          (driftMkt.direction === "yes" && jupMkt.direction === "down") ||
          (driftMkt.direction === "no" && jupMkt.direction === "up")
        );

        if (!isComplement) continue;

        // CROSS_MERGE: Buy YES on Drift + YES on Jupiter (complementary pair)
        // If driftAsk + jupAsk < 1, buying both guarantees profit
        const mergeSum = driftMkt.askPrice + jupMkt.askPrice;
        const mergeSpread = 1 - mergeSum;

        if (mergeSpread > MIN_CROSS_SPREAD) {
          const estProfit = mergeSpread * TRADE_SIZE_USD;
          const platformFees = mergeSum * TRADE_SIZE_USD * 0.005;
          const txFees = 0.002 * CONFIG.SOL_PRICE_USD;
          const netProfit = estProfit - platformFees - txFees;

          if (netProfit > 0) {
            opps.push({
              type: "cross_merge",
              marketA: driftMkt,
              marketB: jupMkt,
              spread: mergeSpread,
              estProfit: netProfit,
            });
          }
        }

        // CROSS_SPLIT: Sell YES on Drift + Sell YES on Jupiter
        // If driftBid + jupBid > 1, selling both guarantees profit
        if (driftMkt.bidPrice > 0 && jupMkt.bidPrice > 0) {
          const splitSum = driftMkt.bidPrice + jupMkt.bidPrice;
          const splitSpread = splitSum - 1;

          if (splitSpread > MIN_CROSS_SPREAD) {
            const estProfit = splitSpread * TRADE_SIZE_USD;
            const platformFees = splitSum * TRADE_SIZE_USD * 0.005;
            const txFees = 0.002 * CONFIG.SOL_PRICE_USD;
            const netProfit = estProfit - platformFees - txFees;

            if (netProfit > 0) {
              opps.push({
                type: "cross_split",
                marketA: driftMkt,
                marketB: jupMkt,
                spread: splitSpread,
                estProfit: netProfit,
              });
            }
          }
        }

        // Also check same direction cross-platform arb
        // If same event, same direction: one platform's YES is cheaper than the other
        if (driftMkt.direction === jupMkt.direction) {
          // Buy on cheaper, sell on expensive
          if (driftMkt.askPrice < jupMkt.bidPrice) {
            const spread = jupMkt.bidPrice - driftMkt.askPrice;
            if (spread > MIN_CROSS_SPREAD) {
              opps.push({
                type: "cross_merge",
                marketA: driftMkt, // buy here (cheap)
                marketB: jupMkt,   // sell here (expensive)
                spread,
                estProfit: spread * TRADE_SIZE_USD * 0.99,
              });
            }
          }
          if (jupMkt.askPrice < driftMkt.bidPrice) {
            const spread = driftMkt.bidPrice - jupMkt.askPrice;
            if (spread > MIN_CROSS_SPREAD) {
              opps.push({
                type: "cross_merge",
                marketA: jupMkt,   // buy here (cheap)
                marketB: driftMkt, // sell here (expensive)
                spread,
                estProfit: spread * TRADE_SIZE_USD * 0.99,
              });
            }
          }
        }
      }
    }
  }

  return opps.sort((a, b) => b.estProfit - a.estProfit);
}

// ── Jupiter Order Creation (reuse from arb-engine) ──────
async function createJupBuyOrder(
  marketId: string,
  isYes: boolean,
  contracts: number,
  depositUsd: number,
): Promise<string | null> {
  try {
    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes,
      isBuy: true,
      contracts,
      depositAmount: String(Math.floor(depositUsd * 1_000_000)),
      depositMint: CONFIG.JUP_USD_MINT,
    };

    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[JUP-ORDER] Error ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;
    return data.transaction || null;
  } catch (err) {
    console.error("[JUP-ORDER] Error:", err);
    return null;
  }
}

async function createJupSellOrder(
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

    const res = await jupFetch(`${CONFIG.JUP_PREDICT_API}/orders`, {
      method: "POST",
      headers: jupHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.transaction || null;
  } catch {
    return null;
  }
}

// ── Drift Order via Gateway (REST) ──────────────────────
// For atomic Jito bundles, we need Drift instructions as raw transactions.
// The Drift Gateway (localhost:8080) provides this when self-hosted.
// Fallback: use @drift-labs/sdk directly for instruction building.
const DRIFT_GATEWAY = process.env.DRIFT_GATEWAY_URL || "";

async function createDriftBuyOrder(
  marketIndex: number,
  direction: "long" | "short",
  sizeUsd: number,
): Promise<string | null> {
  if (!DRIFT_GATEWAY) {
    console.log("[DRIFT] No DRIFT_GATEWAY_URL — cannot create orders (SDK-only mode not yet implemented)");
    return null;
  }

  try {
    const body = {
      marketType: "perp",
      marketIndex,
      direction,
      quoteAmount: sizeUsd,
      orderType: "market",
    };

    const res = await fetch(`${DRIFT_GATEWAY}/v2/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[DRIFT-ORDER] Error ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;
    return data.transaction || data.tx || null;
  } catch (err) {
    console.error("[DRIFT-ORDER] Error:", err);
    return null;
  }
}

// ── Build & Sign ────────────────────────────────────────
async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);
  return tx;
}

// ── Jito Bundle ─────────────────────────────────────────
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

    console.warn("[JITO] Status unknown after 30s — marking as submitted/pending");
    return bundleId; // May have landed
  } catch (err) {
    console.error("[JITO] Submission error:", err);
    return null;
  }
}

// ── Execute Cross-Arb ───────────────────────────────────
async function executeCrossArb(opp: CrossArbOpportunity): Promise<void> {
  const { type, marketA, marketB, spread, estProfit } = opp;
  const icon = type === "cross_merge" ? "🔄" : "🔀";

  console.log(`\n[CROSS] ${icon} ═══ EXECUTING ${type.toUpperCase()} ══════════════════`);
  console.log(`[CROSS] ${marketA.platform}:${marketA.title} ↔ ${marketB.platform}:${marketB.title}`);
  console.log(`[CROSS] Spread: ${(spread * 100).toFixed(3)}% | Est profit: $${estProfit.toFixed(4)}`);

  if (DRY_RUN) {
    console.log(`[CROSS] 🏜️ DRY RUN — would execute. Set DRIFT_DRY_RUN=false to go live.`);
    marketCooldowns.set(`${marketA.marketId}-cross`, Date.now());

    // Log to DB
    await supabase.from("arb_opportunities").insert({
      market_a_id: marketA.marketId,
      market_b_id: marketB.marketId,
      side_a: `${marketA.platform}_${marketA.direction}`,
      side_b: `${marketB.platform}_${marketB.direction}`,
      price_a: marketA.askPrice,
      price_b: marketB.askPrice,
      spread,
      status: "dry_run",
    });
    return;
  }

  // ── Build both legs ───────────────────────────────────
  let txA: string | null = null;
  let txB: string | null = null;
  const contracts = Math.floor(TRADE_SIZE_USD / Math.max(marketA.askPrice, 0.01));

  if (type === "cross_merge") {
    // Buy on both platforms
    if (marketA.platform === "jupiter_predict") {
      txA = await createJupBuyOrder(marketA.marketId, true, contracts, marketA.askPrice * contracts);
    } else if (marketA.platform === "drift" && marketA.marketIndex !== undefined) {
      txA = await createDriftBuyOrder(marketA.marketIndex, "long", TRADE_SIZE_USD);
    }

    if (marketB.platform === "jupiter_predict") {
      txB = await createJupBuyOrder(marketB.marketId, true, contracts, marketB.askPrice * contracts);
    } else if (marketB.platform === "drift" && marketB.marketIndex !== undefined) {
      txB = await createDriftBuyOrder(marketB.marketIndex, "long", TRADE_SIZE_USD);
    }
  } else {
    // Sell on both platforms
    if (marketA.platform === "jupiter_predict") {
      txA = await createJupSellOrder(marketA.marketId, true, contracts);
    }
    if (marketB.platform === "jupiter_predict") {
      txB = await createJupSellOrder(marketB.marketId, true, contracts);
    }
    // Drift sell via Gateway
    if (marketA.platform === "drift" && marketA.marketIndex !== undefined) {
      txA = await createDriftBuyOrder(marketA.marketIndex, "short", TRADE_SIZE_USD);
    }
    if (marketB.platform === "drift" && marketB.marketIndex !== undefined) {
      txB = await createDriftBuyOrder(marketB.marketIndex, "short", TRADE_SIZE_USD);
    }
  }

  if (!txA || !txB) {
    console.log("[CROSS] ⚠️ Could not build both legs — aborting (zero risk)");
    marketCooldowns.set(`${marketA.marketId}-cross`, Date.now());
    return;
  }

  // Sign and bundle
  const [signedA, signedB] = await Promise.all([
    buildAndSign(txA),
    buildAndSign(txB),
  ]);

  console.log("[CROSS] Submitting atomic Jito bundle...");
  const { data: oppRow } = await supabase.from("arb_opportunities").insert({
    market_a_id: marketA.marketId,
    market_b_id: marketB.marketId,
    side_a: `${marketA.platform}_${marketA.direction}`,
    side_b: `${marketB.platform}_${marketB.direction}`,
    price_a: marketA.askPrice,
    price_b: marketB.askPrice,
    spread,
    status: "executing",
  }).select("id").single();

  const oppId = oppRow?.id;
  const bundleResult = await sendJitoBundle([signedA, signedB]);
  marketCooldowns.set(`${marketA.marketId}-cross`, Date.now());

  if (bundleResult) {
    console.log(`[CROSS] ✅ Bundle landed! ${bundleResult}`);
    if (oppId) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId,
        amount_usd: TRADE_SIZE_USD,
        realized_pnl: estProfit,
        fees: 0.005 * TRADE_SIZE_USD * 2,
        status: "filled",
        side_a_tx: bs58.encode(signedA.signatures[0]),
        side_b_tx: bs58.encode(signedB.signatures[0]),
      });
      await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
    }
  } else {
    console.error("[CROSS] ❌ Bundle failed — zero capital at risk");
    if (oppId) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId,
        amount_usd: 0,
        realized_pnl: 0,
        fees: 0,
        status: "failed",
        error_message: "Jito bundle rejected",
      });
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
    }
  }
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan() {
  try {
    scanCount++;
    const verbose = scanCount % 10 === 0;

    if (verbose) {
      console.log(`\n[SCAN] #${scanCount} ${new Date().toISOString()} ─────────────────`);
    }

    const [driftMarkets, jupMarkets] = await Promise.all([
      fetchDriftBETMarkets(),
      fetchJupiterCrossMarkets(),
    ]);

    if (driftMarkets.length === 0) {
      if (verbose) console.log("[SCAN] No Drift BET markets — retrying");
      return;
    }
    if (jupMarkets.length === 0) {
      if (verbose) console.log("[SCAN] No Jupiter markets — retrying");
      return;
    }

    if (verbose) {
      console.log(`[SCAN] Drift: ${driftMarkets.length} | Jupiter: ${jupMarkets.length}`);
    }

    const opps = findCrossArbs(driftMarkets, jupMarkets);

    if (opps.length === 0) {
      if (verbose) console.log("[SCAN] No cross-platform arbs above threshold");
      return;
    }

    console.log(`\n[SCAN] 🎯 FOUND ${opps.length} cross-platform opportunities!`);
    for (const o of opps.slice(0, 5)) {
      console.log(
        `  ${o.type === "cross_merge" ? "🔄" : "🔀"} [${o.type}] ` +
        `${o.marketA.symbol} ${o.marketA.platform}↔${o.marketB.platform} ` +
        `spread=${(o.spread * 100).toFixed(3)}% profit=$${o.estProfit.toFixed(4)}`
      );
    }

    // Execute top opportunity
    await executeCrossArb(opps[0]);
  } catch (err) {
    console.error("[SCAN] Error:", err);
  }
}

async function scanLoop() {
  while (true) {
    await runScan();
    await sleep(SCAN_INTERVAL_MS);
  }
}

// ── Start ───────────────────────────────────────────────
async function main() {
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`[DRIFT-JUP] Wallet SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch {
    console.warn("[DRIFT-JUP] Could not check wallet balance");
  }

  if (!CONFIG.JUP_PREDICT_API_KEY) {
    console.warn("[DRIFT-JUP] ⚠️ No JUP_PREDICT_API_KEY — may be rate-limited");
  }

  if (!DRIFT_GATEWAY) {
    console.warn("[DRIFT-JUP] ⚠️ No DRIFT_GATEWAY_URL — live execution requires self-hosted Drift Gateway");
    console.warn("[DRIFT-JUP] Running in scan-only mode (dry run) — will detect opportunities but not execute");
  }

  console.log("[DRIFT-JUP] Starting cross-platform scan loop...\n");
  scanLoop();
}

main().catch(console.error);
