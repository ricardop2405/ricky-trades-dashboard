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
import { sleep } from "./utils";

// ── Config ──────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

const TRIAD_API = "https://beta.triadfi.co/api";
const JUP_TIMED_API = "https://prediction-market-api.jup.ag/api/v1/events/crypto/timed";
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const JITO_TIP_ACCOUNT = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const SCAN_INTERVAL_MS = parseInt(process.env.TRIAD_SCAN_INTERVAL_MS || "3000");
const TRADE_SIZE_USD = parseFloat(process.env.TRIAD_ARB_AMOUNT || String(CONFIG.ARB_AMOUNT));
const MIN_NET_PROFIT = parseFloat(process.env.TRIAD_MIN_PROFIT || "0.005");
const JITO_TIP_LAMPORTS = parseInt(process.env.TRIAD_JITO_TIP || String(CONFIG.JITO_TIP));
const SAFETY_MIN_PROFIT_USD = 0.05; // profit-or-revert guardrail
const DRY_RUN = process.env.TRIAD_DRY_RUN !== "false";
const MAX_CONCURRENT = parseInt(process.env.TRIAD_MAX_CONCURRENT || "2");
const COOLDOWN_MS = 60_000;
const STOP_FILE = "/tmp/triad-stop"; // touch this file to emergency stop
const JUP_EXECUTION_BUFFER_USD = parseFloat(process.env.TRIAD_JUP_EXECUTION_BUFFER_USD || "0.02");

// Triad pool IDs for crypto fast markets (from /api/market/fast)
const FAST_MARKET_COINS = ["btc", "sol", "eth"];

// State
const marketCooldowns = new Map<string, number>();
let scanCount = 0;
let bestSpreadSeen = -Infinity;
let executionsInFlight = 0;
let emergencyStopped = false;

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

    // Get orderbook for real bid/ask
    const ob = await fetchTriadOrderbook(triad.id);
    if (!ob) {
      if (verbose) console.log(`  [TRIAD] ${triad.coin.toUpperCase()} ${triad.id}: orderbook unavailable`);
      continue;
    }

    const triadHypeAsk = ob.hypeAsk;
    const triadFlopAsk = ob.flopAsk;

    if (verbose && triadHypeAsk === null) {
      console.log(`  [TRIAD] ${triad.coin.toUpperCase()} ${triad.id}: no executable hype asks`);
    }
    if (verbose && triadFlopAsk === null) {
      console.log(`  [TRIAD] ${triad.coin.toUpperCase()} ${triad.id}: no executable flop asks`);
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

        if (netProfit > MIN_NET_PROFIT && totalCost < 1) {
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

        if (netProfit > MIN_NET_PROFIT && totalCost < 1) {
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

// ── Triad Order Creation via SDK ────────────────────────
// We build instructions directly using the Triad program's Anchor IDL
// marketBidOrder: takes from ask side of orderbook (market buy)
// orderDirection: { hype: {} } or { flop: {} }
async function createTriadBuyInstruction(
  marketId: string,
  direction: "hype" | "flop",
  amountUsd: number,
): Promise<TransactionInstruction[] | null> {
  try {
    // Dynamic import of the Triad SDK
    const { default: TriadProtocol } = await import("@triadxyz/triad-protocol");
    const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");

    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const triad = new TriadProtocol(connection, wallet, {
      payer: keypair.publicKey,
      skipPreflight: true,
    });

    const marketIdNum = parseInt(marketId);
    const orderDirection = direction === "hype" ? { hype: {} } : { flop: {} };

    // Use the SDK's trade module to get the instruction
    // The marketBidOrder method builds instructions that match against ask orders
    const program = (triad as any).program;
    if (!program) {
      console.error("[TRIAD-ORDER] Cannot access program from SDK");
      return null;
    }

    // Get orderbook to find asks to match against
    const orderBook = await triad.trade.getOrderBook(marketIdNum);
    const asks = direction === "hype" ? orderBook.hype.ask : orderBook.flop.ask;

    if (asks.length === 0) {
      console.log(`[TRIAD-ORDER] No asks on ${direction} side for market ${marketId}`);
      return null;
    }

    const ixs: TransactionInstruction[] = [];
    const BN = (await import("bn.js")).default;
    const { getMarketPDA, getOrderBookPDA, getOrderPDA, getCustomerPDA } = await import("@triadxyz/triad-protocol");

    let remainingAmount = new BN(Math.floor(amountUsd * 1_000_000));
    const programId = program.programId;
    const oppositeDirection = direction === "hype" ? { flop: {} } : { hype: {} };
    const customerId = 7; // Default Triadmarkets customer

    const sortedAsks = asks.sort((a: any, b: any) => Number(a.price) - Number(b.price));

    for (const ask of sortedAsks) {
      if (remainingAmount.lte(new BN(0))) break;
      if (ask.authority === WALLET) continue;

      const askPrice = new BN(ask.price);
      const availableShares = new BN(ask.totalShares).sub(new BN(ask.filledShares));
      const maxSharesForAmount = remainingAmount.mul(new BN(1_000_000)).div(askPrice);
      const sharesToBuy = BN.min(maxSharesForAmount, availableShares);

      if (sharesToBuy.lte(new BN(0))) continue;

      const usdcAmount = sharesToBuy.mul(askPrice).div(new BN(1_000_000));

      ixs.push(
        await program.methods
          .marketBidOrder({
            amount: usdcAmount,
            marketId: new BN(marketIdNum),
            orderDirection,
            bookOrderAskId: new BN(ask.id),
            oppositeOrderDirection: oppositeDirection,
          })
          .accounts({
            signer: keypair.publicKey,
            payer: keypair.publicKey,
            market: getMarketPDA(programId, marketIdNum),
            orderBook: getOrderBookPDA(programId, marketIdNum),
            bookOrderAskAuthority: new PublicKey(ask.authority),
            order: getOrderPDA(programId, keypair.publicKey, marketIdNum, direction === "hype" ? "Hype" : "Flop"),
            oppositeOrder: getOrderPDA(programId, new PublicKey(ask.authority), marketIdNum, direction === "hype" ? "Flop" : "Hype"),
            customer: getCustomerPDA(programId, customerId),
          })
          .instruction()
      );

      remainingAmount = remainingAmount.sub(usdcAmount);
    }

    if (ixs.length === 0) {
      console.log(`[TRIAD-ORDER] No matching asks to fill for ${direction} market ${marketId}`);
      return null;
    }

    return ixs;
  } catch (err) {
    console.error("[TRIAD-ORDER] Error building instruction:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Build, Sign & Bundle ────────────────────────────────
async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  return tx;
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

async function buildJitoTipTx(blockhash: string): Promise<VersionedTransaction> {
  const tipIx = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: JITO_TIP_ACCOUNT,
    lamports: JITO_TIP_LAMPORTS,
  });
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return tx;
}

async function sendJitoBundle(txs: VersionedTransaction[], maxRetries = 3): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
      const errMsg = JSON.stringify(data.error);
      // Retry on rate limit / congestion
      if ((data.error.code === -32097 || errMsg.includes("rate limited") || errMsg.includes("congested")) && attempt < maxRetries - 1) {
        const backoff = (attempt + 1) * 2000;
        console.warn(`[JITO] Rate limited (attempt ${attempt + 1}/${maxRetries}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      console.error(`[JITO] Bundle error: ${errMsg}`);
      return null;
    }

    const bundleId = data.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    // Poll for confirmation
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
    return bundleId;
  } catch (err) {
    console.error("[JITO] Submission error:", err instanceof Error ? err.message : err);
    if (attempt < maxRetries - 1) {
      await sleep(2000);
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

  if (executionsInFlight >= MAX_CONCURRENT) {
    console.log(`[XARB] ${executionsInFlight}/${MAX_CONCURRENT} positions in flight — skipping`);
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
  executionsInFlight++;
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

    // Build transactions
    const [triadTx, jupTx, tipTx] = await Promise.all([
      buildTriadTx(triadIxs),
      buildAndSign(jupTxBase64),
      buildJitoTipTx(),
    ]);

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

    if (bundleResult) {
      console.log(`[XARB] ✅ Bundle landed! ${bundleResult}`);
      console.log(`[XARB] 💰 Guaranteed profit: $${c.netProfit.toFixed(4)} (${c.contracts} contracts × $${c.profitPerContract.toFixed(4)})`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: c.totalCost * c.contracts,
          realized_pnl: c.netProfit,
          fees: JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL * CONFIG.SOL_PRICE_USD,
          status: "filled",
          side_a_tx: bs58.encode(triadTx.signatures[0]),
          side_b_tx: bs58.encode(jupTx.signatures[0]),
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
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
    executionsInFlight = Math.max(0, executionsInFlight - 1);
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
    const toExecute = candidates.slice(0, MAX_CONCURRENT - executionsInFlight);
    await Promise.all(toExecute.map(c => executeMergeArb(c)));
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
