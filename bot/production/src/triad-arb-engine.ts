/**
 * RICKY TRADES — Triad ↔ Jupiter Predict Cross-Platform Arb v1
 *
 * Strategy: Cross-platform price differences on the SAME crypto outcome
 *   - Both platforms have 5-min "Up or Down" binary markets for BTC, ETH, SOL
 *   - If Triad hype(Up) is cheaper than Jupiter's sellYes(Up) → buy Triad, sell Jupiter
 *   - If Jupiter buyYes(Up) is cheaper than Triad's bid → buy Jupiter, sell Triad
 *   - Non-atomic: sequential execution (Triad first, then Jupiter or vice versa)
 *
 * Triad API:   beta.triadfi.co/api/market/{poolId} (no auth)
 * Jupiter API: prediction-market-api.jup.ag/api/v1/events/crypto/timed
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Config ──────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

const TRIAD_API = "https://beta.triadfi.co/api";
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";

const SCAN_INTERVAL_MS = parseInt(process.env.TRIAD_SCAN_INTERVAL_MS || "3000");
const ARB_AMOUNT = parseFloat(process.env.TRIAD_ARB_AMOUNT || String(CONFIG.ARB_AMOUNT));
const MIN_NET_PROFIT = parseFloat(process.env.TRIAD_MIN_PROFIT || "0.005");
const DRY_RUN = process.env.TRIAD_DRY_RUN !== "false";
const COOLDOWN_MS = 60_000;

// Triad pool IDs for crypto fast markets (correct IDs from /api/market/fast)
const FAST_MARKET_POOLS = [
  { poolId: "163", coin: "btc" },
  { poolId: "164", coin: "sol" },
  { poolId: "165", coin: "eth" },
];

// State
const marketCooldowns = new Map<string, number>();
let scanCount = 0;
let bestSpreadSeen = -Infinity;

// ── Proxy for Jupiter (region-blocked) ──────────────────
const PROXY_URL = process.env.PROXY_URL || "";
let proxyAgent: any = null;
if (PROXY_URL && !PROXY_URL.includes("your-proxy") && !PROXY_URL.includes("placeholder")) {
  if (PROXY_URL.startsWith("socks")) {
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } else {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
  }
  console.log(`[XARB] Proxy: ${PROXY_URL.replace(/\/\/.*@/, "//***@")}`);
} else {
  console.log("[XARB] No valid proxy — Jupiter calls go direct");
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
console.log("  RICKY TRADES — Triad ↔ Jupiter Cross-Arb v1");
console.log("═══════════════════════════════════════════════════════");
console.log(`[XARB] Wallet:       ${WALLET}`);
console.log(`[XARB] Amount/trade: $${ARB_AMOUNT}`);
console.log(`[XARB] Min profit:   $${MIN_NET_PROFIT}`);
console.log(`[XARB] Scan:         ${SCAN_INTERVAL_MS}ms`);
console.log(`[XARB] Dry run:      ${DRY_RUN}`);
console.log(`[XARB] Proxy:        ${PROXY_URL ? "YES" : "NONE"}`);
console.log(`[XARB] Strategy:     Cross-platform price difference`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface TriadMarket {
  id: string;
  marketAddress: string;
  marketStart: number;
  marketEnd: number;
  question: string;
  winningDirection: string;
  isFast: boolean;
  hypePrice: number; // YES/Up price
  flopPrice: number; // NO/Down price
  payoutFee: number;
  volume: number;
}

interface JupSide {
  marketId: string;
  buyYes: number;  // ask — cost to buy YES
  sellYes: number; // bid — proceeds from selling YES
}

interface JupEvent {
  coin: string;
  interval: string;
  title: string;
  up: JupSide;
  down: JupSide;
  closeTime: number;
  openTime: number;
}

interface CrossArbCandidate {
  coin: string;
  direction: "up" | "down"; // Which outcome we're arbing
  strategy: string;
  triadPrice: number;       // Triad price (buy or sell)
  jupPrice: number;         // Jupiter price (sell or buy)
  spread: number;           // Price difference
  netProfit: number;
  remaining: number;
  triadMarket: TriadMarket;
  jupEvent: JupEvent;
}

// ── Triad API ───────────────────────────────────────────
const TRIAD_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://triadfi.co/",
  "Origin": "https://triadfi.co",
  "sec-ch-ua": '"Chromium";v="125", "Not-A.Brand";v="24", "Google Chrome";v="125"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

async function fetchTriadMarkets(coin: string, poolId: string): Promise<TriadMarket[]> {
  try {
    // Use the /api/market/fast endpoint which returns all fast market pools
    const res = await fetch(`${TRIAD_API}/market/fast?lang=en-US`, { headers: TRIAD_HEADERS });
    if (!res.ok) return [];
    const pools = await res.json() as any[];
    // Find the pool matching our coin's poolId
    const pool = pools.find((p: any) => String(p.id) === poolId);
    if (!pool) return [];
    const markets: TriadMarket[] = pool.markets || [];
    return markets.filter(m => m.winningDirection === "None" && m.isFast);
  } catch {
    return [];
  }
}

async function fetchTriadOrderbook(marketId: string): Promise<{ hypeBid: number; hypeAsk: number; flopBid: number; flopAsk: number } | null> {
  try {
    const res = await fetch(`${TRIAD_API}/market/${marketId}/orderbook`, { headers: TRIAD_HEADERS });
    if (!res.ok) return null;
    const ob = await res.json();

    const hypeAsk = ob.hype?.ask?.length > 0 ? Math.min(...ob.hype.ask.map((l: any) => l.price)) : 0.5;
    const hypeBid = ob.hype?.bid?.length > 0 ? Math.max(...ob.hype.bid.map((l: any) => l.price)) : 0.5;
    const flopAsk = ob.flop?.ask?.length > 0 ? Math.min(...ob.flop.ask.map((l: any) => l.price)) : 0.5;
    const flopBid = ob.flop?.bid?.length > 0 ? Math.max(...ob.flop.bid.map((l: any) => l.price)) : 0.5;

    return { hypeBid, hypeAsk, flopBid, flopAsk };
  } catch {
    return null;
  }
}

// ── Jupiter Predict API ─────────────────────────────────
async function fetchJupiterEvents(coin: string): Promise<JupEvent[]> {
  const events: JupEvent[] = [];

  for (const interval of ["5m", "15m"]) {
    try {
      const url = `${JUP_TIMED_API}?subcategory=${coin}&tags=${interval}`;
      const res = await jupFetch(url, { headers: jupHeaders() });
      if (!res.ok) continue;

      const data = await res.json() as any;
      const rawEvents = Array.isArray(data) ? data : data.data || data.events || [];
      const now = Date.now() / 1000;

      for (const event of rawEvents) {
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

        events.push({
          coin,
          interval,
          title: event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`,
          up: { marketId: upMarket.marketId, buyYes: upBuyYes, sellYes: upSellYes },
          down: { marketId: downMarket.marketId, buyYes: downBuyYes, sellYes: downSellYes },
          closeTime,
          openTime,
        });
      }
    } catch (err) {
      console.error(`[JUP] Fetch error for ${coin}/${interval}:`, err);
    }
  }

  return events;
}

// ── Cross-Platform Matching ─────────────────────────────
// Match Triad and Jupiter markets by:
// 1. Same coin (BTC/ETH/SOL)
// 2. Overlapping time windows (both close around the same time)
// Then compare prices for arb opportunities

async function findCrossArbCandidates(): Promise<CrossArbCandidate[]> {
  const candidates: CrossArbCandidate[] = [];
  const now = Date.now() / 1000;
  const verbose = scanCount % 10 === 0;

  // Fetch Triad + Jupiter in parallel for all coins
  const coinData = await Promise.all(
    FAST_MARKET_POOLS.map(async (p) => {
      const [triadMarkets, jupEvents] = await Promise.all([
        fetchTriadMarkets(p.coin, p.poolId),
        fetchJupiterEvents(p.coin),
      ]);
      return { coin: p.coin, triadMarkets, jupEvents };
    })
  );

  for (const { coin, triadMarkets, jupEvents } of coinData) {
    if (verbose) {
      console.log(`  [${coin.toUpperCase()}] Triad: ${triadMarkets.length} open markets | Jupiter: ${jupEvents.length} events`);
    }

    if (triadMarkets.length === 0 || jupEvents.length === 0) continue;

    for (const triad of triadMarkets) {
      const remaining = triad.marketEnd - now;
      if (remaining < 30 || remaining > 6 * 60) continue;

      const cooldownKey = `${coin}-${triad.id}`;
      if (marketCooldowns.has(cooldownKey) && Date.now() - marketCooldowns.get(cooldownKey)! < COOLDOWN_MS) continue;

      // Get Triad orderbook for real bid/ask
      const ob = await fetchTriadOrderbook(triad.id);
      const triadHypeAsk = ob?.hypeAsk ?? triad.hypePrice;
      const triadHypeBid = ob?.hypeBid ?? triad.hypePrice;
      const triadFlopAsk = ob?.flopAsk ?? triad.flopPrice;
      const triadFlopBid = ob?.flopBid ?? triad.flopPrice;

      const hasOB = ob && (ob.hypeAsk !== 0.5 || ob.hypeBid !== 0.5 || ob.flopAsk !== 0.5 || ob.flopBid !== 0.5);

      // Match with Jupiter events by close time (within 2 min window)
      let matched = false;
      for (const jup of jupEvents) {
        const timeDiff = Math.abs(triad.marketEnd - jup.closeTime);
        if (timeDiff > 120) continue;
        matched = true;

        if (verbose) {
          console.log(
            `    🔗 MATCH ${coin.toUpperCase()} close±${Math.round(timeDiff)}s | ` +
            `Triad: hype=$${triadHypeAsk.toFixed(4)}/${triadHypeBid.toFixed(4)} flop=$${triadFlopAsk.toFixed(4)}/${triadFlopBid.toFixed(4)}${hasOB ? " 📖" : ""} | ` +
            `Jup: up=$${jup.up.buyYes.toFixed(4)}/${jup.up.sellYes.toFixed(4)} down=$${jup.down.buyYes.toFixed(4)}/${jup.down.sellYes.toFixed(4)}`
          );

          // Show all 4 spread calculations
          const s1 = jup.up.sellYes - triadHypeAsk;
          const s2 = triadHypeBid - jup.up.buyYes;
          const s3 = jup.down.sellYes - triadFlopAsk;
          const s4 = triadFlopBid - jup.down.buyYes;
          console.log(
            `    📊 Spreads: buyTriad/sellJup(Up)=${(s1*100).toFixed(2)}% buyJup/sellTriad(Up)=${(s2*100).toFixed(2)}% ` +
            `buyTriad/sellJup(Dn)=${(s3*100).toFixed(2)}% buyJup/sellTriad(Dn)=${(s4*100).toFixed(2)}%`
          );
        }

        const txFee = 0.002 * CONFIG.SOL_PRICE_USD;

        // Strategy 1: Buy Up on Triad (cheap), Sell Up on Jupiter (expensive)
        // Profit = jupSellYes(Up) - triadHypeAsk - fees
        {
          const spread = jup.up.sellYes - triadHypeAsk;
          const netProfit = (spread * ARB_AMOUNT) - txFee;
          if (spread > 0) {
            if (spread > bestSpreadSeen) bestSpreadSeen = spread;
          }
          if (netProfit > MIN_NET_PROFIT) {
            candidates.push({
              coin, direction: "up",
              strategy: "BUY_TRIAD_SELL_JUP",
              triadPrice: triadHypeAsk, jupPrice: jup.up.sellYes,
              spread, netProfit, remaining,
              triadMarket: triad, jupEvent: jup,
            });
          }
        }

        // Strategy 2: Buy Up on Jupiter (cheap), Sell Up on Triad (expensive)
        // Profit = triadHypeBid - jupBuyYes(Up) - fees
        {
          const spread = triadHypeBid - jup.up.buyYes;
          const netProfit = (spread * ARB_AMOUNT) - txFee;
          if (spread > 0) {
            if (spread > bestSpreadSeen) bestSpreadSeen = spread;
          }
          if (netProfit > MIN_NET_PROFIT) {
            candidates.push({
              coin, direction: "up",
              strategy: "BUY_JUP_SELL_TRIAD",
              triadPrice: triadHypeBid, jupPrice: jup.up.buyYes,
              spread, netProfit, remaining,
              triadMarket: triad, jupEvent: jup,
            });
          }
        }

        // Strategy 3: Buy Down on Triad (cheap), Sell Down on Jupiter (expensive)
        {
          const spread = jup.down.sellYes - triadFlopAsk;
          const netProfit = (spread * ARB_AMOUNT) - txFee;
          if (spread > 0) {
            if (spread > bestSpreadSeen) bestSpreadSeen = spread;
          }
          if (netProfit > MIN_NET_PROFIT) {
            candidates.push({
              coin, direction: "down",
              strategy: "BUY_TRIAD_SELL_JUP",
              triadPrice: triadFlopAsk, jupPrice: jup.down.sellYes,
              spread, netProfit, remaining,
              triadMarket: triad, jupEvent: jup,
            });
          }
        }

        // Strategy 4: Buy Down on Jupiter (cheap), Sell Down on Triad (expensive)
        {
          const spread = triadFlopBid - jup.down.buyYes;
          const netProfit = (spread * ARB_AMOUNT) - txFee;
          if (spread > 0) {
            if (spread > bestSpreadSeen) bestSpreadSeen = spread;
          }
          if (netProfit > MIN_NET_PROFIT) {
            candidates.push({
              coin, direction: "down",
              strategy: "BUY_JUP_SELL_TRIAD",
              triadPrice: triadFlopBid, jupPrice: jup.down.buyYes,
              spread, netProfit, remaining,
              triadMarket: triad, jupEvent: jup,
            });
          }
        }
      }

      if (!matched && verbose) {
        console.log(`    ❌ Triad "${triad.question}" (closes ${new Date(triad.marketEnd * 1000).toISOString().slice(11,19)}) — no Jupiter match within 2min`);
      }
    }
  }

  return candidates.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute cross-arb ───────────────────────────────────
async function executeCrossArb(c: CrossArbCandidate): Promise<void> {
  console.log(`\n[XARB] ═══ CROSS-ARB OPPORTUNITY ══════════════════════`);
  console.log(`[XARB] ${c.coin.toUpperCase()} ${c.direction.toUpperCase()} — ${c.strategy}`);
  console.log(`[XARB] Triad: $${c.triadPrice.toFixed(4)} | Jupiter: $${c.jupPrice.toFixed(4)}`);
  console.log(`[XARB] Spread: ${(c.spread * 100).toFixed(3)}% | Net: $${c.netProfit.toFixed(4)}`);
  console.log(`[XARB] Time remaining: ${Math.round(c.remaining)}s`);
  console.log(`[XARB] Triad market: ${c.triadMarket.question}`);
  console.log(`[XARB] Jupiter event: ${c.jupEvent.title}`);

  if (DRY_RUN) {
    console.log(`[XARB] 🏜️ DRY RUN — logging opportunity only`);
    marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());

    // Log to DB
    await supabase.from("arb_opportunities").insert({
      market_a_id: c.triadMarket.id,
      market_b_id: c.jupEvent.up.marketId,
      side_a: `triad_${c.direction === "up" ? "hype" : "flop"}`,
      side_b: `jup_${c.direction}_yes`,
      price_a: c.triadPrice,
      price_b: c.jupPrice,
      spread: c.spread,
      status: "detected",
    });

    return;
  }

  // TODO: Live execution
  // 1. Place order on Triad (on-chain via program)
  // 2. Place order on Jupiter Predict (via API)
  // Sequential — not atomic, so use small size and fast execution
  console.log(`[XARB] ⚠️ Live execution not yet implemented`);
  marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan(): Promise<void> {
  try {
    scanCount++;
    const verbose = scanCount % 10 === 0;

    if (verbose) {
      console.log(`\n[SCAN] #${scanCount} ${new Date().toISOString()} ─────────────────`);
    }

    const candidates = await findCrossArbCandidates();

    if (candidates.length === 0) {
      if (verbose) {
        console.log(`[SCAN] No cross-platform opportunities`);
        console.log(`  📈 Best spread seen: ${bestSpreadSeen === -Infinity ? "N/A" : (bestSpreadSeen * 100).toFixed(3) + "%"}`);
      }
      return;
    }

    console.log(`\n[SCAN] 🎯 FOUND ${candidates.length} cross-arb opportunities!`);
    for (const c of candidates.slice(0, 5)) {
      console.log(
        `  💰 ${c.coin.toUpperCase()} ${c.direction} ${c.strategy} ` +
        `triad=$${c.triadPrice.toFixed(4)} jup=$${c.jupPrice.toFixed(4)} ` +
        `spread=${(c.spread * 100).toFixed(2)}% net=$${c.netProfit.toFixed(4)}`
      );
    }

    await executeCrossArb(candidates[0]);
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
    console.log(`[XARB] SOL balance: ${(balance / 1e9).toFixed(4)}`);

    // Verify Triad API
    const triadTest = await fetch(`${TRIAD_API}/points/levels`, { headers: TRIAD_HEADERS });
    console.log(`[XARB] Triad API: ${triadTest.ok ? "✅" : "❌ " + triadTest.status}`);

    // Verify Jupiter API
    let jupOk = false;
    try {
      const jupTest = await jupFetch(`${JUP_TIMED_API}?subcategory=btc&tags=5m`, { headers: jupHeaders() });
      if (!jupTest.ok) {
        const body = await jupTest.text();
        if (body.includes("unsupported_region")) {
          console.warn("[XARB] ⚠️ Jupiter API region-blocked — set PROXY_URL. Will scan Triad-only spreads.");
        } else {
          console.warn(`[XARB] ⚠️ Jupiter API error: ${jupTest.status}. Will retry in scan loop.`);
        }
      } else {
        const testData = await jupTest.json() as any;
        const testEvents = Array.isArray(testData) ? testData : testData.data || testData.events || [];
        console.log(`[XARB] Jupiter API: ✅ (${testEvents.length} BTC/5m events)`);
        jupOk = true;
      }
    } catch (err: any) {
      console.warn(`[XARB] ⚠️ Jupiter API unreachable: ${err.message?.slice(0, 80)}. Will retry in scan loop.`);
    }

    console.log("[XARB] Starting cross-platform scan...\n");
    await scanLoop();
  } catch (err) {
    console.error("[XARB] Fatal error:", err);
    process.exit(1);
  }
}

main().catch(console.error);
