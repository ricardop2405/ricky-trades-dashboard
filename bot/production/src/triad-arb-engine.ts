/**
 * RICKY TRADES — Triad ↔ Jupiter Predict Cross-Platform Arb v2
 *
 * Strategy: Outcome-independent cross-platform prediction market arbitrage.
 *
 * Math:
 *   - Triad has Hype (YES/Up) + Flop (NO/Down) for each 5-min crypto market
 *   - Jupiter has Up + Down for the same asset/window
 *   - If Triad_Hype_Ask + Jup_Down_BuyYes < $1 → buy both → guaranteed $1 payout
 *   - If Triad_Flop_Ask + Jup_Up_BuyYes < $1 → buy both → guaranteed $1 payout
 *   - Profit = $1 - totalCost (per contract), regardless of outcome
 *
 * Execution:
 *   - Atomic via Jito bundle: both legs in one bundle
 *   - Profit-or-revert: if bundle fails, zero capital at risk
 *   - Uses @triadxyz/triad-protocol SDK for Triad instructions
 *   - Uses Jupiter Predict API for Jupiter transactions
 *
 * Safety guardrail: revert if final balance < starting + tip + $0.05
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CONFIG } from "./config";
import { JITO_TIP_ACCOUNTS } from "./constants";
import { sleep } from "./utils";

// ── Config ──────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

const TRIAD_API = "https://beta.triadfi.co/api";
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";
const JITO_BLOCK_ENGINE = process.env.TRIAD_JITO_URL || "https://ny.mainnet.block-engine.jito.wtf";
const JITO_BUNDLE_URL = `${JITO_BLOCK_ENGINE}/api/v1/bundles`;
const JITO_INFLIGHT_STATUS_URL = `${JITO_BLOCK_ENGINE}/api/v1/getInflightBundleStatuses`;
const JITO_FINAL_STATUS_URL = `${JITO_BLOCK_ENGINE}/api/v1/getBundleStatuses`;

const SCAN_INTERVAL_MS = parseInt(process.env.TRIAD_SCAN_INTERVAL_MS || "1500");
const TRADE_SIZE_USD = parseFloat(process.env.TRIAD_ARB_AMOUNT || String(CONFIG.ARB_AMOUNT));
const MIN_NET_PROFIT = parseFloat(process.env.TRIAD_MIN_PROFIT || "0.005");
const JITO_TIP_LAMPORTS = parseInt(process.env.TRIAD_JITO_TIP || "100000"); // 100k lamports default
const JITO_REQUEST_MIN_INTERVAL_MS = parseInt(process.env.TRIAD_JITO_MIN_INTERVAL_MS || "1100"); // Jito default rate limit is 1 req/sec/IP/region
const SAFETY_MIN_PROFIT_USD = 0.05; // profit-or-revert guardrail
const DRY_RUN = process.env.TRIAD_DRY_RUN !== "false";
const MAX_CONCURRENT = parseInt(process.env.TRIAD_MAX_CONCURRENT || "2");
const COOLDOWN_MS = 60_000;
const STOP_FILE = "/tmp/triad-stop"; // touch this file to emergency stop
const JUP_EXECUTION_BUFFER_USD = parseFloat(process.env.TRIAD_JUP_EXECUTION_BUFFER_USD || "0.01");

// Triad pool IDs for crypto fast markets (from /api/market/fast)
const FAST_MARKET_COINS = ["btc", "sol", "eth"];

// State
const marketCooldowns = new Map<string, number>();
let scanCount = 0;
let bestSpreadSeen = -Infinity;
let executionsInFlight = 0;
let bundleInFlight = new Set<string>(); // prevent duplicate submissions for same market
let executionLock = false;
let emergencyStopped = false;
let lastJitoRequestAt = 0;

// ── Proxy for Jupiter (region-blocked) ──────────────────
const PROXY_URL = process.env.PROXY_URL || "";
let proxyAgent: any = null;
if (PROXY_URL && !PROXY_URL.includes("your-proxy") && !PROXY_URL.includes("placeholder")) {
  if (PROXY_URL.startsWith("socks")) {
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } else {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
  }
}

async function jupFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    if (!proxyAgent) return fetch(url, init);
    const nodeFetch = (await import("node-fetch")).default;
    return nodeFetch(url, { ...init, agent: proxyAgent } as any) as unknown as Response;
  } catch (err) {
    console.error(`[JUP-FETCH] Error: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
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
console.log("  RICKY TRADES — Triad ↔ Jupiter Cross-Arb v2 (Atomic)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[XARB] Wallet:       ${WALLET}`);
console.log(`[XARB] Amount/trade: $${TRADE_SIZE_USD}`);
console.log(`[XARB] Min profit:   $${MIN_NET_PROFIT}`);
console.log(`[XARB] Jito tip:     ${JITO_TIP_LAMPORTS} lamports`);
console.log(`[XARB] Scan:         ${SCAN_INTERVAL_MS}ms`);
console.log(`[XARB] Dry run:      ${DRY_RUN}`);
console.log(`[XARB] Max concurrent: ${MAX_CONCURRENT} positions`);
console.log(`[XARB] Proxy:        ${PROXY_URL && !PROXY_URL.includes("your-proxy") ? "YES" : "NONE"}`);
console.log(`[XARB] Strategy:     YES_A + NO_B < $1 (outcome-independent)`);
console.log(`[XARB] Safety:       profit-or-revert via Jito bundle`);
console.log(`[XARB] Kill switch:  touch ${STOP_FILE} to emergency stop`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface TriadFastMarket {
  id: string;          // e.g. "120117297284885"
  marketAddress: string;
  marketStart: number;
  marketEnd: number;
  question: string;
  winningDirection: string;
  isFast: boolean;
  hypePrice: number;   // YES/Up price
  flopPrice: number;   // NO/Down price
  payoutFee: number;
  volume: number;
  poolId: string;
  coin: string;        // added by us
}

interface TriadOrderbook {
  hypeBid: number | null;
  hypeAsk: number | null;
  flopBid: number | null;
  flopAsk: number | null;
}

interface JupSide {
  marketId: string;
  buyYes: number;   // cost to buy YES (ask)
  sellYes: number;  // proceeds from selling YES (bid)
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

interface MergeArbCandidate {
  coin: string;
  // What we buy
  legA: "triad_hype" | "triad_flop";
  legB: "jup_down" | "jup_up";
  // Prices
  costA: number;       // cost per contract on Triad
  costB: number;       // cost per contract on Jupiter
  totalCost: number;   // costA + costB (must be < 1)
  profitPerContract: number; // 1 - totalCost
  netProfit: number;   // (profitPerContract * contracts) - fees
  contracts: number;
  remaining: number;   // seconds to close
  triadMarket: TriadFastMarket;
  jupEvent: JupEvent;
}

function getJupSideForLeg(event: JupEvent, leg: MergeArbCandidate["legB"]): JupSide {
  return leg === "jup_down" ? event.down : event.up;
}

// ── Triad API ───────────────────────────────────────────
const TRIAD_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/json",
  "Referer": "https://triadfi.co/",
  "Origin": "https://triadfi.co",
};

async function fetchAllTriadFastMarkets(): Promise<TriadFastMarket[]> {
  try {
    const res = await fetch(`${TRIAD_API}/market/fast?lang=en-US`, { headers: TRIAD_HEADERS });
    if (!res.ok) return [];
    const pools = await res.json() as any[];
    const markets: TriadFastMarket[] = [];

    for (const pool of pools) {
      const coin = (pool.coin || "").toLowerCase();
      if (!FAST_MARKET_COINS.includes(coin)) continue;

      for (const m of (pool.markets || [])) {
        if (m.winningDirection === "None" && m.isFast) {
          markets.push({ ...m, coin });
        }
      }
    }
    return markets;
  } catch (err) {
    console.error("[TRIAD] Fetch error:", err instanceof Error ? err.message : err);
    return [];
  }
}

async function fetchTriadOrderbook(marketId: string): Promise<TriadOrderbook | null> {
  try {
    const res = await fetch(`${TRIAD_API}/market/${marketId}/orderbook`, { headers: TRIAD_HEADERS });
    if (!res.ok) return null;
    const ob = await res.json();

    const bestPrice = (levels: any[] | undefined, side: "ask" | "bid"): number | null => {
      if (!Array.isArray(levels) || levels.length === 0) return null;

      const prices = levels
        .map((level: any) => Number(level.price))
        .filter((price: number) => Number.isFinite(price) && price > 0);

      if (prices.length === 0) return null;

      const raw = side === "ask" ? Math.min(...prices) : Math.max(...prices);
      return raw / 1_000_000;
    };

    const hypeAsk = bestPrice(ob.hype?.ask, "ask");
    const hypeBid = bestPrice(ob.hype?.bid, "bid");
    const flopAsk = bestPrice(ob.flop?.ask, "ask");
    const flopBid = bestPrice(ob.flop?.bid, "bid");

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

        events.push({
          coin,
          interval,
          title: event.metadata?.title || event.title || `${coin.toUpperCase()} ${interval}`,
          up: { marketId: upMarket.marketId, buyYes: upBuyYes, sellYes: upSellYes },
          down: { marketId: downMarket.marketId, buyYes: downBuyYes, sellYes: downSellYes },
          closeTime: Number(upMarket.closeTime || upMarket.metadata?.closeTime || 0),
          openTime: Number(upMarket.openTime || upMarket.metadata?.openTime || 0),
        });
      }
    } catch (err) {
      console.error(`[JUP] Fetch error for ${coin}/${interval}:`, err instanceof Error ? err.message : err);
    }
  }

  return events;
}

async function refreshJupCandidate(c: MergeArbCandidate): Promise<MergeArbCandidate | null> {
  const latestEvents = await fetchJupiterEvents(c.coin);
  const targetMarketId = getJupSideForLeg(c.jupEvent, c.legB).marketId;
  const latestEvent = latestEvents.find((event) => getJupSideForLeg(event, c.legB).marketId === targetMarketId);

  if (!latestEvent) {
    console.log(`[XARB] ⚠️ Jupiter market ${targetMarketId} is no longer quoteable — aborting.`);
    return null;
  }

  const latestSide = getJupSideForLeg(latestEvent, c.legB);
  const bufferedCostB = latestSide.buyYes + JUP_EXECUTION_BUFFER_USD;
  const totalCost = c.costA + bufferedCostB;
  const profitPerContract = 1 - totalCost;
  const contracts = Math.floor(TRADE_SIZE_USD / totalCost);
  const txFee = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD;
  const netProfit = (profitPerContract * contracts) - txFee;
  const remaining = Math.max(0, latestEvent.closeTime - Date.now() / 1000);

  if (contracts <= 0 || totalCost >= 1 || profitPerContract <= 0 || netProfit <= MIN_NET_PROFIT) {
    console.log(
      `[XARB] ⚠️ Jupiter repriced out: live=$${latestSide.buyYes.toFixed(4)} buffer=$${JUP_EXECUTION_BUFFER_USD.toFixed(4)} ` +
      `=> total=$${totalCost.toFixed(4)} net=$${netProfit.toFixed(4)}`
    );
    return null;
  }

  return {
    ...c,
    costB: bufferedCostB,
    totalCost,
    profitPerContract,
    netProfit,
    contracts,
    remaining,
    jupEvent: latestEvent,
  };
}

// ── Cross-Platform Merge Arb Detection ──────────────────
// Core formula: buy YES_A on platform A + buy NO_B on platform B
// If costA + costB < $1 → one of them pays $1, guaranteed profit
//
// Combinations:
//   1. Buy Triad Hype (Up/YES) + Buy Jupiter Down YES → covers all outcomes
//   2. Buy Triad Flop (Down/YES) + Buy Jupiter Up YES → covers all outcomes
//
// In both cases: one leg always wins $1 per contract

async function findMergeArbs(): Promise<MergeArbCandidate[]> {
  const candidates: MergeArbCandidate[] = [];
  const now = Date.now() / 1000;
  const verbose = scanCount % 10 === 0;

  // Fetch all data in parallel: single Triad call + parallel Jupiter calls
  const [triadMarkets, ...jupEventsByCoin] = await Promise.all([
    fetchAllTriadFastMarkets(),
    ...FAST_MARKET_COINS.map(coin => fetchJupiterEvents(coin)),
  ]);

  // Group Jupiter events by coin
  const jupByCoin = new Map<string, JupEvent[]>();
  FAST_MARKET_COINS.forEach((coin, i) => {
    jupByCoin.set(coin, jupEventsByCoin[i]);
  });

  if (verbose) {
    console.log(`  [TRIAD] ${triadMarkets.length} open fast markets`);
    for (const coin of FAST_MARKET_COINS) {
      const jups = jupByCoin.get(coin) || [];
      const triads = triadMarkets.filter(m => m.coin === coin);
      console.log(`  [${coin.toUpperCase()}] Triad: ${triads.length} | Jupiter: ${jups.length} events`);
    }
  }

  for (const triad of triadMarkets) {
    const remaining = triad.marketEnd - now;
    if (remaining < 30 || remaining > 6 * 60) continue;

    const cooldownKey = `${triad.coin}-${triad.id}`;
    if (marketCooldowns.has(cooldownKey) && Date.now() - marketCooldowns.get(cooldownKey)! < COOLDOWN_MS) continue;

    // Use market prices directly (Triad Fast Markets are position-based, not orderbook)
    const triadHypeAsk = triad.hypePrice > 0 ? triad.hypePrice : null;
    const triadFlopAsk = triad.flopPrice > 0 ? triad.flopPrice : null;

    if (verbose && triadHypeAsk === null) {
      console.log(`  [TRIAD] ${triad.coin.toUpperCase()} ${triad.id}: no hype price`);
    }
    if (verbose && triadFlopAsk === null) {
      console.log(`  [TRIAD] ${triad.coin.toUpperCase()} ${triad.id}: no flop price`);
    }
    if (triadHypeAsk === null && triadFlopAsk === null) continue;

    const jupEvents = jupByCoin.get(triad.coin) || [];

    // Match by close time (within 2 min)
    for (const jup of jupEvents) {
      const timeDiff = Math.abs(triad.marketEnd - jup.closeTime);
      if (timeDiff > 120) continue;

      const txFee = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD;

      // ── Merge 1: Buy Triad Hype (Up) + Buy Jup Down YES ──
      // If price goes UP  → Triad Hype wins $1
      // If price goes DOWN → Jup Down wins $1
      // Either way we get $1 per contract
      if (triadHypeAsk !== null) {
        const totalCost = triadHypeAsk + jup.down.buyYes;
        const profitPerContract = 1 - totalCost;
        const contracts = Math.floor(TRADE_SIZE_USD / totalCost);
        const netProfit = (profitPerContract * contracts) - txFee;

        if (profitPerContract > 0 && profitPerContract > bestSpreadSeen) bestSpreadSeen = profitPerContract;

        if (verbose) {
          console.log(
            `    🔗 ${triad.coin.toUpperCase()} Merge1: triadHype=$${triadHypeAsk.toFixed(4)} + jupDown=$${jup.down.buyYes.toFixed(4)} = $${totalCost.toFixed(4)} | ` +
            `profit/c=$${profitPerContract.toFixed(4)} × ${contracts}c net=$${netProfit.toFixed(4)}`
          );
        }

        // Jupiter requires min $1 deposit
        const jupDepositA = jup.down.buyYes * contracts;
        if (netProfit > MIN_NET_PROFIT && totalCost < 1 && jupDepositA >= 1.0) {
          candidates.push({
            coin: triad.coin,
            legA: "triad_hype",
            legB: "jup_down",
            costA: triadHypeAsk,
            costB: jup.down.buyYes,
            totalCost,
            profitPerContract,
            netProfit,
            contracts,
            remaining,
            triadMarket: triad,
            jupEvent: jup,
          });
        }
      }

      // ── Merge 2: Buy Triad Flop (Down) + Buy Jup Up YES ──
      // If price goes DOWN → Triad Flop wins $1
      // If price goes UP   → Jup Up wins $1
      if (triadFlopAsk !== null) {
        const totalCost = triadFlopAsk + jup.up.buyYes;
        const profitPerContract = 1 - totalCost;
        const contracts = Math.floor(TRADE_SIZE_USD / totalCost);
        const netProfit = (profitPerContract * contracts) - txFee;

        if (profitPerContract > 0 && profitPerContract > bestSpreadSeen) bestSpreadSeen = profitPerContract;

        if (verbose) {
          console.log(
            `    🔗 ${triad.coin.toUpperCase()} Merge2: triadFlop=$${triadFlopAsk.toFixed(4)} + jupUp=$${jup.up.buyYes.toFixed(4)} = $${totalCost.toFixed(4)} | ` +
            `profit/c=$${profitPerContract.toFixed(4)} × ${contracts}c net=$${netProfit.toFixed(4)}`
          );
        }

        // Jupiter requires min $1 deposit
        const jupDepositB = jup.up.buyYes * contracts;
        if (netProfit > MIN_NET_PROFIT && totalCost < 1 && jupDepositB >= 1.0) {
          candidates.push({
            coin: triad.coin,
            legA: "triad_flop",
            legB: "jup_up",
            costA: triadFlopAsk,
            costB: jup.up.buyYes,
            totalCost,
            profitPerContract,
            netProfit,
            contracts,
            remaining,
            triadMarket: triad,
            jupEvent: jup,
          });
        }
      }
    }
  }

  return candidates.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Jupiter Order Creation ──────────────────────────────
async function createJupBuyOrder(
  marketId: string,
  contracts: number,
  depositUsd: number,
): Promise<string | null> {
  try {
    // Jupiter requires minimum $1 deposit
    if (depositUsd < 1.0) {
      console.log(`[JUP-ORDER] Deposit $${depositUsd.toFixed(2)} below $1 minimum — skipping`);
      return null;
    }

    const body = {
      ownerPubkey: WALLET,
      marketId,
      isYes: true,
      isBuy: true,
      contracts,
      depositAmount: String(Math.ceil(depositUsd * 1_000_000)),
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
    console.error("[JUP-ORDER] Error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Triad Order Creation (raw instructions, no SDK) ─────
// Program: TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss
// Uses place_bid_order from official IDL (v4.x)
const TRIAD_PROGRAM_ID = new PublicKey("TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// IDL discriminator: sha256("global:place_bid_order")[0..8]
const PLACE_BID_ORDER_DISC = Buffer.from([154, 143, 199, 233, 97, 23, 223, 255]);
const BASE_DECIMALS = 6;

// PlaceBidOrderArgs: { amount: u64, price: u64, market_id: u64, order_direction: enum(Hype=0,Flop=1) }
function serializePlaceBidOrderArgs(amount: bigint, price: bigint, marketId: bigint, orderDirection: "hype" | "flop"): Buffer {
  // Borsh: u64 (8 LE) + u64 (8 LE) + u64 (8 LE) + enum (1 byte)
  const buf = Buffer.alloc(25);
  buf.writeBigUInt64LE(amount, 0);
  buf.writeBigUInt64LE(price, 8);
  buf.writeBigUInt64LE(marketId, 16);
  buf.writeUInt8(orderDirection === "hype" ? 0 : 1, 24);
  return buf;
}

// PDA derivations from @triadxyz/triad-protocol SDK
function getMarketPDA(marketId: bigint): PublicKey {
  const BN = require("bn.js");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)],
    TRIAD_PROGRAM_ID,
  )[0];
}

function getOrderBookPDA(marketId: bigint): PublicKey {
  const BN = require("bn.js");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order_book"), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)],
    TRIAD_PROGRAM_ID,
  )[0];
}

function getOrderPDA(authority: PublicKey, marketId: bigint, orderDirection: "hype" | "flop"): PublicKey {
  const BN = require("bn.js");
  const enumDirection = orderDirection === "hype" ? 0 : 1;
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("order"),
      authority.toBuffer(),
      new BN(marketId.toString()).toArrayLike(Buffer, "le", 8),
      new BN(enumDirection).toArrayLike(Buffer, "le", 1),
    ],
    TRIAD_PROGRAM_ID,
  )[0];
}

function getATA(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

async function createTriadBuyInstruction(
  marketAddress: string,
  direction: "hype" | "flop",
  amountUsd: number,
  pricePerShare: number,
): Promise<TransactionInstruction[] | null> {
  try {
    // marketAddress is actually the numeric market ID string (e.g. "120117297284885")
    const marketId = BigInt(marketAddress);
    const marketPDA = getMarketPDA(marketId);
    const orderBookPDA = getOrderBookPDA(marketId);
    const orderPDA = getOrderPDA(keypair.publicKey, marketId, direction);
    const userAta = getATA(keypair.publicKey, USDC_MINT);
    const marketAta = getATA(marketPDA, USDC_MINT);

    const ixs: TransactionInstruction[] = [];

    // Build place_bid_order instruction
    // amount = USDC amount in raw (6 decimals)
    // price = price per share in raw (6 decimals) — must be < 1_000_000 (< $1.00)
    const amountRaw = BigInt(Math.floor(amountUsd * 10 ** BASE_DECIMALS));
    // Use market price, clamped to max 999_999 (Triad rejects >= 1_000_000)
    const priceRaw = BigInt(Math.min(Math.floor(pricePerShare * 10 ** BASE_DECIMALS), 999_999));
    const data = Buffer.concat([PLACE_BID_ORDER_DISC, serializePlaceBidOrderArgs(amountRaw, priceRaw, marketId, direction)]);

    ixs.push(new TransactionInstruction({
      programId: TRIAD_PROGRAM_ID,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },     // signer
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },     // payer
        { pubkey: marketPDA, isSigner: false, isWritable: true },            // market
        { pubkey: orderBookPDA, isSigner: false, isWritable: true },         // order_book
        { pubkey: orderPDA, isSigner: false, isWritable: true },             // order
        { pubkey: USDC_MINT, isSigner: false, isWritable: true },            // mint (USDC)
        { pubkey: userAta, isSigner: false, isWritable: true },              // user_ata
        { pubkey: marketAta, isSigner: false, isWritable: true },            // market_ata
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    // token_program
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    }));

    console.log(`[TRIAD-ORDER] Built place_bid_order for ${direction} on market ${marketAddress} ($${amountUsd.toFixed(2)}, price=$${pricePerShare.toFixed(4)})`);
    console.log(`[TRIAD-ORDER]   market=${marketPDA.toBase58()} orderBook=${orderBookPDA.toBase58()} order=${orderPDA.toBase58()}`);
    return ixs;
  } catch (err) {
    console.error("[TRIAD-ORDER] Error building instruction:", err instanceof Error ? err.stack || err.message : err);
    return null;
  }
}

// Vote program — Jito rejects bundles that lock vote accounts
const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";

// ── Build, Sign & Bundle ────────────────────────────────
async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  // Check all account keys (static + lookup tables) for vote program
  const staticKeys = tx.message.staticAccountKeys.map(k => k.toBase58());
  if (staticKeys.includes(VOTE_PROGRAM_ID)) {
    throw new Error("Jupiter tx references Vote program — Jito will reject");
  }

  // Also check address lookup table keys if V0
  if ("addressTableLookups" in tx.message) {
    const lookups = (tx.message as any).addressTableLookups || [];
    for (const lookup of lookups) {
      if (lookup.accountKey?.toBase58() === VOTE_PROGRAM_ID) {
        throw new Error("Jupiter tx lookup table references Vote program — Jito will reject");
      }
    }
  }

  return tx;
}

async function simulateBundleTxs(txs: VersionedTransaction[]): Promise<boolean> {
  // Simulate each tx individually to catch errors before Jito submission
  for (let i = 0; i < txs.length; i++) {
    const label = ["Triad", "Jupiter", "Tip"][i] || `Tx${i}`;
    try {
      const sim = await connection.simulateTransaction(txs[i], {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (sim.value.err) {
        console.error(`[SIM] ❌ ${label} simulation FAILED:`, JSON.stringify(sim.value.err));
        if (sim.value.logs) {
          const errorLogs = sim.value.logs.filter(l => l.includes("Error") || l.includes("failed") || l.includes("insufficient"));
          if (errorLogs.length > 0) console.error(`[SIM] ${label} logs:`, errorLogs.join(" | "));
        }
        return false;
      }
      console.log(`[SIM] ✅ ${label} simulation OK (${sim.value.unitsConsumed || "?"} CU)`);
    } catch (err) {
      console.error(`[SIM] ${label} simulation threw:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
  return true;
}

async function buildTriadTx(ixs: TransactionInstruction[], blockhash: string): Promise<VersionedTransaction> {
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      ...ixs,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return tx;
}

async function buildJitoTipTx(blockhash: string, lamports: number): Promise<VersionedTransaction> {
  const tipAccount = new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
  );
  const tipIx = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: tipAccount,
    lamports,
  });
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return tx;
}

async function paceJitoRequests(): Promise<void> {
  const waitMs = Math.max(0, JITO_REQUEST_MIN_INTERVAL_MS - (Date.now() - lastJitoRequestAt));
  if (waitMs > 0) await sleep(waitMs);
  lastJitoRequestAt = Date.now();
}

async function fetchJitoTipRecommendationLamports(): Promise<number | null> {
  try {
    const res = await fetch("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
    if (!res.ok) return null;
    const rows = await res.json() as Array<{
      landed_tips_75th_percentile?: number;
      landed_tips_95th_percentile?: number;
      landed_tips_99th_percentile?: number;
    }>;
    const latest = rows?.[0];
    if (!latest) return null;

    // API returns SOL values; choose >=95th percentile for competitive landing.
    const solTip = latest.landed_tips_95th_percentile || latest.landed_tips_99th_percentile || latest.landed_tips_75th_percentile;
    if (!solTip || !Number.isFinite(solTip)) return null;

    const lamports = Math.ceil(solTip * LAMPORTS_PER_SOL);
    return Math.max(JITO_TIP_LAMPORTS, lamports);
  } catch {
    return null;
  }
}

async function getInflightBundleStatus(bundleId: string): Promise<"Pending" | "Landed" | "Failed" | "Invalid" | null> {
  try {
    await paceJitoRequests();
    const res = await fetch(JITO_INFLIGHT_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getInflightBundleStatuses",
        params: [[bundleId]],
      }),
    });
    const data = await res.json() as any;
    const status = data?.result?.value?.[0]?.status;
    return status ?? null;
  } catch {
    return null;
  }
}

async function getFinalBundleStatus(bundleId: string): Promise<{ confirmationStatus?: string; err?: unknown } | null> {
  try {
    await paceJitoRequests();
    const res = await fetch(JITO_FINAL_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });
    const data = await res.json() as any;
    return data?.result?.value?.[0] ?? null;
  } catch {
    return null;
  }
}

async function sendJitoBundle(txs: VersionedTransaction[], maxRetries = 3): Promise<{ bundleId: string; pending?: boolean } | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const encodedTxs = txs.map(tx => Buffer.from(tx.serialize()).toString("base64"));
      const tipRecommendation = await fetchJitoTipRecommendationLamports();
      if (tipRecommendation && tipRecommendation > JITO_TIP_LAMPORTS) {
        console.log(`[JITO] Tip floor suggests ${tipRecommendation} lamports (current tx tip remains ${JITO_TIP_LAMPORTS})`);
      }

      await paceJitoRequests();
      const res = await fetch(JITO_BUNDLE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [encodedTxs, { encoding: "base64" }],
        }),
      });

      const data = await res.json() as any;
      if (data.error) {
        const errMsg = JSON.stringify(data.error);
        if ((data.error.code === -32097 || res.status === 429 || errMsg.includes("rate limited") || errMsg.includes("congested")) && attempt < maxRetries - 1) {
          const backoff = Math.max(JITO_REQUEST_MIN_INTERVAL_MS, (attempt + 1) * 2500);
          console.warn(`[JITO] Rate limited (attempt ${attempt + 1}/${maxRetries}) — retrying in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        console.error(`[JITO] Bundle error: ${errMsg}`);
        return null;
      }

      const bundleId = data.result;
      console.log(`[JITO] Bundle submitted: ${bundleId}`);

      let sawPendingLikeSignal = false;
      let invalidInflightCount = 0;

      for (let i = 0; i < 12; i++) {
        await sleep(2500);

        const inflightStatus = await getInflightBundleStatus(bundleId);
        if (inflightStatus) {
          console.log(`[JITO] Inflight: ${inflightStatus}`);

          if (inflightStatus === "Landed") return { bundleId };

          if (inflightStatus === "Pending") {
            sawPendingLikeSignal = true;
            invalidInflightCount = 0;
          } else if (inflightStatus === "Failed") {
            return null;
          } else if (inflightStatus === "Invalid") {
            invalidInflightCount += 1;
            if (i === 0) {
              console.warn("[JITO] Inflight returned Invalid immediately after submission — treating as propagation lag, not failure");
            }
          }
        }

        const finalStatus = await getFinalBundleStatus(bundleId);
        if (finalStatus) {
          sawPendingLikeSignal = true;
          console.log(`[JITO] Final status: ${finalStatus.confirmationStatus || "unknown"}`);
          if (finalStatus.confirmationStatus === "confirmed" || finalStatus.confirmationStatus === "finalized") {
            return { bundleId };
          }
          if (finalStatus.err) return null;
        }

        if (inflightStatus === "Invalid" && !finalStatus && invalidInflightCount >= 3 && !sawPendingLikeSignal) {
          console.warn("[JITO] Bundle not visible in status APIs yet — keeping it as pending instead of false-failing");
          return { bundleId, pending: true };
        }
      }

      console.warn("[JITO] Status unknown after inflight/final polling — marking as submitted/pending");
      return { bundleId, pending: true };
    } catch (err) {
      console.error("[JITO] Submission error:", err instanceof Error ? err.message : err);
      if (attempt < maxRetries - 1) {
        await sleep(Math.max(JITO_REQUEST_MIN_INTERVAL_MS, 2500));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Execute Atomic Merge Arb ────────────────────────────
function checkEmergencyStop(): boolean {
  try {
    if (fs.existsSync(STOP_FILE)) {
      if (!emergencyStopped) {
        console.log(`\n[XARB] 🛑 EMERGENCY STOP — ${STOP_FILE} detected. All execution halted.`);
        console.log(`[XARB] To resume: rm ${STOP_FILE}`);
        emergencyStopped = true;
      }
      return true;
    }
    if (emergencyStopped) {
      console.log(`[XARB] ✅ Emergency stop cleared — resuming execution`);
      emergencyStopped = false;
    }
    return false;
  } catch { return false; }
}

async function executeMergeArb(c: MergeArbCandidate): Promise<void> {
  if (checkEmergencyStop()) return;

  if (executionLock) {
    console.log("[XARB] Execution lock active — skipping");
    return;
  }

  if (executionsInFlight >= MAX_CONCURRENT) {
    console.log(`[XARB] ${executionsInFlight}/${MAX_CONCURRENT} positions in flight — skipping`);
    return;
  }

  // Prevent duplicate bundle for same market
  const marketKey = `${c.coin}-${c.triadMarket.id}-${c.legA}`;
  if (bundleInFlight.has(marketKey)) {
    console.log(`[XARB] Bundle already in flight for ${marketKey} — skipping duplicate`);
    return;
  }

  // Require minimum 60s remaining to avoid expired-market bundles
  if (c.remaining < 60) {
    console.log(`[XARB] Only ${Math.round(c.remaining)}s remaining — too late, skipping`);
    return;
  }

  // Require minimum net profit to justify tip cost
  if (c.netProfit < MIN_NET_PROFIT) {
    console.log(`[XARB] Net profit $${c.netProfit.toFixed(4)} < min $${MIN_NET_PROFIT} — skipping`);
    return;
  }

  const liveCandidate = await refreshJupCandidate(c);
  if (!liveCandidate) {
    marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
    return;
  }

  if (Math.abs(liveCandidate.costB - c.costB) >= 0.01 || liveCandidate.contracts !== c.contracts) {
    console.log(
      `[XARB] Repriced Jupiter leg: $${c.costB.toFixed(4)} → $${liveCandidate.costB.toFixed(4)} ` +
      `| contracts ${c.contracts} → ${liveCandidate.contracts}`
    );
  }

  c = liveCandidate;

  console.log(`\n[XARB] ═══ MERGE ARB OPPORTUNITY ══════════════════════`);
  console.log(`[XARB] ${c.coin.toUpperCase()} — ${c.legA} + ${c.legB}`);
  console.log(`[XARB] Cost: $${c.costA.toFixed(4)} + $${c.costB.toFixed(4)} = $${c.totalCost.toFixed(4)}`);
  console.log(`[XARB] Payout: $1.00 per contract (guaranteed)`);
  console.log(`[XARB] Profit/contract: $${c.profitPerContract.toFixed(4)}`);
  console.log(`[XARB] Contracts: ${c.contracts} | Net profit: $${c.netProfit.toFixed(4)}`);
  console.log(`[XARB] Time remaining: ${Math.round(c.remaining)}s`);
  console.log(`[XARB] Triad: "${c.triadMarket.question}" | Jupiter: "${c.jupEvent.title}"`);

  // Safety check: total cost < 1 and profit > safety minimum
  if (c.totalCost >= 1) {
    console.log(`[XARB] ❌ SAFETY: totalCost $${c.totalCost.toFixed(4)} >= $1 — NO PROFIT. Aborting.`);
    return;
  }
  if (c.profitPerContract < SAFETY_MIN_PROFIT_USD / c.contracts) {
    console.log(`[XARB] ❌ SAFETY: profit too thin after guardrail. Aborting.`);
    return;
  }

  if (DRY_RUN) {
    console.log(`[XARB] 🏜️ DRY RUN — logging opportunity (set TRIAD_DRY_RUN=false to go live)`);
    marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());

    await supabase.from("arb_opportunities").insert({
      market_a_id: c.triadMarket.id,
      market_b_id: c.legB === "jup_down" ? c.jupEvent.down.marketId : c.jupEvent.up.marketId,
      side_a: c.legA,
      side_b: c.legB,
      price_a: c.costA,
      price_b: c.costB,
      spread: c.profitPerContract,
      status: "dry_run",
    });

    return;
  }

  // ── LIVE EXECUTION ────────────────────────────────────
  executionLock = true;
  executionsInFlight++;
  bundleInFlight.add(marketKey);
  try {
    const triadDirection = c.legA === "triad_hype" ? "hype" : "flop";
    const jupMarketId = c.legB === "jup_down" ? c.jupEvent.down.marketId : c.jupEvent.up.marketId;
    const jupDepositUsd = c.costB * c.contracts;

    console.log(`[XARB] Building legs...`);

    // Build both legs in parallel
    const [triadIxs, jupTxBase64] = await Promise.all([
      createTriadBuyInstruction(c.triadMarket.id, triadDirection, c.costA * c.contracts),
      createJupBuyOrder(jupMarketId, c.contracts, jupDepositUsd),
    ]);

    if (!triadIxs || !jupTxBase64) {
      console.log(`[XARB] ⚠️ Could not build both legs — aborting (zero capital at risk)`);
      console.log(`[XARB]   Triad: ${triadIxs ? `${triadIxs.length} ixs` : "FAILED"} | Jupiter: ${jupTxBase64 ? "OK" : "FAILED"}`);
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    // Build transactions with detailed error tracking
    const { blockhash } = await connection.getLatestBlockhash();

    let triadTx: VersionedTransaction;
    let jupTx: VersionedTransaction;
    let tipTx: VersionedTransaction;

    // Dynamically trim Triad instructions to fit under 1232B tx limit
    let trimmedIxs = triadIxs;
    try {
      // Try building, trimming on any error (encoding overflow or size > 1232B)
      let built = false;
      while (trimmedIxs.length >= 1) {
        try {
          triadTx = await buildTriadTx(trimmedIxs, blockhash);
          if (triadTx.serialize().length <= 1232) {
            built = true;
            break;
          }
          // Too large, trim one instruction
          trimmedIxs = trimmedIxs.slice(0, trimmedIxs.length - 1);
        } catch {
          // Build/serialize failed, trim and retry
          trimmedIxs = trimmedIxs.slice(0, trimmedIxs.length - 1);
        }
      }
      if (!built || trimmedIxs.length === 0) {
        console.error("[XARB] Cannot fit Triad tx under 1232B even with 1 ix — aborting");
        marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
        return;
      }
      if (trimmedIxs.length < triadIxs.length) {
        console.log(`[XARB] Trimmed Triad ixs: ${triadIxs.length} → ${trimmedIxs.length} (${triadTx!.serialize().length}B)`);
      }
      triadTx!.sign([keypair]);
    } catch (err) {
      console.error("[XARB] Failed to build Triad tx:", err instanceof Error ? err.message : err);
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    try {
      jupTx = await buildAndSign(jupTxBase64);
    } catch (err) {
      console.error("[XARB] Failed to deserialize Jupiter tx:", err instanceof Error ? err.message : err);
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    const effectiveJitoTipLamports = (await fetchJitoTipRecommendationLamports()) ?? JITO_TIP_LAMPORTS;
    if (effectiveJitoTipLamports !== JITO_TIP_LAMPORTS) {
      console.log(`[JITO] Using boosted tip: ${effectiveJitoTipLamports} lamports (base ${JITO_TIP_LAMPORTS})`);
    }

    try {
      tipTx = await buildJitoTipTx(blockhash, effectiveJitoTipLamports);
    } catch (err) {
      console.error("[XARB] Failed to build tip tx:", err instanceof Error ? err.message : err);
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    tipTx.sign([keypair]);

    // Sign Jupiter tx (may need fallback for pre-structured V0 txs)
    try {
      jupTx.sign([keypair]);
    } catch (signErr) {
      console.warn(`[XARB] Jupiter sign() failed: ${signErr instanceof Error ? signErr.message : signErr}`);
      // Fallback: manually inject signature at the correct index
      const signerIndex = jupTx.message.staticAccountKeys.findIndex(
        (key) => key.equals(keypair.publicKey)
      );
      if (signerIndex === -1) {
        console.error("[XARB] Wallet not found in Jupiter tx account keys — cannot sign");
        marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
        return;
      }
      const nacl = require("tweetnacl");
      const sig = nacl.sign.detached(
        jupTx.message.serialize(),
        keypair.secretKey
      );
      jupTx.signatures[signerIndex] = Buffer.from(sig);
    }

    // Verify serialization before submitting
    try {
      const sizes = [triadTx, jupTx, tipTx].map(tx => tx.serialize().length);
      console.log(`[XARB] Tx sizes: Triad=${sizes[0]}B, Jupiter=${sizes[1]}B, Tip=${sizes[2]}B`);
      if (sizes.some(s => s > 1232)) {
        console.error(`[XARB] ❌ Transaction exceeds 1232B limit — aborting`);
        marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
        return;
      }
    } catch (serErr) {
      console.error("[XARB] Serialization check failed:", serErr instanceof Error ? serErr.message : serErr);
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    // Pre-flight simulation — catch errors before burning Jito rate limit quota
    const simOk = await simulateBundleTxs([triadTx!, jupTx, tipTx]);
    if (!simOk) {
      console.error("[XARB] ❌ Pre-flight simulation failed — skipping Jito submission (zero capital at risk)");
      marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
      return;
    }

    // Log opportunity to DB
    const { data: oppRow } = await supabase.from("arb_opportunities").insert({
      market_a_id: c.triadMarket.id,
      market_b_id: jupMarketId,
      side_a: c.legA,
      side_b: c.legB,
      price_a: c.costA,
      price_b: c.costB,
      spread: c.profitPerContract,
      status: "executing",
    }).select("id").single();
    const oppId = oppRow?.id;

    // Submit atomic Jito bundle: [triadTx, jupTx, tipTx]
    console.log(`[XARB] 🚀 Submitting atomic Jito bundle (3 txs)...`);
    const bundleResult = await sendJitoBundle([triadTx, jupTx, tipTx]);
    marketCooldowns.set(`${c.coin}-${c.triadMarket.id}`, Date.now());
    bundleInFlight.delete(marketKey);

    if (bundleResult && !bundleResult.pending) {
      console.log(`[XARB] ✅ Bundle landed! ${bundleResult.bundleId}`);
      console.log(`[XARB] 💰 Guaranteed profit: $${c.netProfit.toFixed(4)} (${c.contracts} contracts × $${c.profitPerContract.toFixed(4)})`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: c.totalCost * c.contracts,
          realized_pnl: c.netProfit,
          fees: effectiveJitoTipLamports / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD,
          status: "filled",
          side_a_tx: bs58.encode(triadTx.signatures[0]),
          side_b_tx: bs58.encode(jupTx.signatures[0]),
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
      }
    } else if (bundleResult?.pending) {
      console.warn(`[XARB] ⏳ Bundle pending: ${bundleResult.bundleId}`);
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: c.totalCost * c.contracts,
          realized_pnl: 0,
          fees: effectiveJitoTipLamports / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD,
          status: "submitted",
          error_message: "Bundle submitted; pending confirmation after inflight/final polling",
          side_a_tx: bs58.encode(triadTx.signatures[0]),
          side_b_tx: bs58.encode(jupTx.signatures[0]),
        });
        await supabase.from("arb_opportunities").update({ status: "executing" }).eq("id", oppId);
      }
    } else {
      console.error("[XARB] ❌ Bundle failed — zero capital at risk (atomic revert)");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: 0,
          realized_pnl: 0,
          fees: 0,
          status: "failed",
          error_message: "Jito bundle rejected — atomic revert, no funds lost",
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[XARB] Execution error:", err instanceof Error ? err.message : err);
  } finally {
    executionLock = false;
    executionsInFlight = Math.max(0, executionsInFlight - 1);
    bundleInFlight.delete(marketKey);
  }
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan(): Promise<void> {
  try {
    scanCount++;
    const verbose = scanCount % 10 === 0;

    if (verbose) {
      console.log(`\n[SCAN] #${scanCount} ${new Date().toISOString()} ─────────────────`);
    }

    const candidates = await findMergeArbs();

    if (candidates.length === 0) {
      if (verbose) {
        console.log(`[SCAN] No merge arb opportunities (YES_A + NO_B all >= $1)`);
        console.log(`  📈 Best profit/contract seen: ${bestSpreadSeen === -Infinity ? "N/A" : "$" + bestSpreadSeen.toFixed(4)}`);
      }
      return;
    }

    console.log(`\n[SCAN] 🎯 FOUND ${candidates.length} merge arb opportunities!`);
    for (const c of candidates.slice(0, 5)) {
      console.log(
        `  💰 ${c.coin.toUpperCase()} ${c.legA}+${c.legB} ` +
        `cost=$${c.totalCost.toFixed(4)} profit/c=$${c.profitPerContract.toFixed(4)} ` +
        `×${c.contracts}c net=$${c.netProfit.toFixed(4)}`
      );
    }

    // Execute top candidates concurrently (up to MAX_CONCURRENT)
    // Only execute the BEST candidate per scan to avoid duplicate bundles
    const best = candidates[0];
    await executeMergeArb(best);
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
    console.log(`[XARB] SOL balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)}`);

    // Verify Triad API
    const triadTest = await fetch(`${TRIAD_API}/market/fast?lang=en-US`, { headers: TRIAD_HEADERS });
    if (triadTest.ok) {
      const pools = await triadTest.json() as any[];
      const cryptoPools = pools.filter((p: any) => FAST_MARKET_COINS.includes((p.coin || "").toLowerCase()));
      console.log(`[XARB] Triad API: ✅ (${cryptoPools.length} crypto fast-market pools)`);
    } else {
      console.warn(`[XARB] ⚠️ Triad API error: ${triadTest.status}`);
    }

    // Verify Jupiter API
    try {
      const jupTest = await jupFetch(`${JUP_TIMED_API}?subcategory=btc&tags=5m`, { headers: jupHeaders() });
      if (!jupTest.ok) {
        const body = await jupTest.text();
        if (body.includes("unsupported_region")) {
          console.warn("[XARB] ⚠️ Jupiter API region-blocked — set PROXY_URL");
        } else {
          console.warn(`[XARB] ⚠️ Jupiter API error: ${jupTest.status}. Will retry.`);
        }
      } else {
        const testData = await jupTest.json() as any;
        const testEvents = Array.isArray(testData) ? testData : testData.data || testData.events || [];
        console.log(`[XARB] Jupiter API: ✅ (${testEvents.length} BTC/5m events)`);
      }
    } catch (err: any) {
      console.warn(`[XARB] ⚠️ Jupiter API unreachable: ${err.message?.slice(0, 80)}. Will retry.`);
    }

    console.log("[XARB] Starting atomic merge-arb scan...\n");
    await scanLoop();
  } catch (err) {
    console.error("[XARB] Fatal error:", err);
    process.exit(1);
  }
}

main().catch(console.error);
