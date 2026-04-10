/**
 * RICKY TRADES — Triad Fast Market Arb Engine v1
 *
 * Strategy: Sum-to-One on Triad 5-minute "Fast Markets"
 *   - Triad Fast Markets: BTC, ETH, SOL — 5-min binary (Up/Down)
 *   - Buy Hype(Up) + Flop(Down) when combined cost < $1.00 payout
 *   - On-chain execution via Triad Solana program
 *
 * Triad API (no auth, CORS *):
 *   - Market data:  beta.triadfi.co/api/market/{poolId}
 *   - Orderbook:    beta.triadfi.co/api/market/{marketId}/orderbook
 *   - Activity:     beta.triadfi.co/api/market/{marketId}/activity
 *
 * On-chain program: TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Config ──────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, { commitment: "confirmed" });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const WALLET = keypair.publicKey.toBase58();

// Triad endpoints
const TRIAD_API = "https://beta.triadfi.co/api";
const TRIAD_PROGRAM_ID = new PublicKey("TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss");
const TRIAD_RPC = "https://triad-solanam-a5ee.mainnet.rpcpool.com/";

// Pool IDs for crypto fast markets (discovered from triadfi.co)
const FAST_MARKET_POOLS = [
  { poolId: "165", coin: "ETH", name: "Ethereum Up or Down - 5 Minutes" },
  { poolId: "166", coin: "BTC", name: "Bitcoin Up or Down - 5 Minutes" },
  { poolId: "167", coin: "SOL", name: "Solana Up or Down - 5 Minutes" },
];

// Jito
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Scan settings
const SCAN_INTERVAL_MS = parseInt(process.env.TRIAD_SCAN_INTERVAL_MS || "2000");
const FAST_SCAN_MS = 500;
const ARB_AMOUNT = parseFloat(process.env.TRIAD_ARB_AMOUNT || String(CONFIG.ARB_AMOUNT));
const MIN_NET_PROFIT = parseFloat(process.env.TRIAD_MIN_PROFIT || "0.005");
const DRY_RUN = process.env.TRIAD_DRY_RUN !== "false"; // default: true (safe)
const COOLDOWN_MS = 60_000;

// State
const marketCooldowns = new Map<string, number>();
let scanCount = 0;
let bestSpreadSeen = -Infinity;
let marketsSeenTotal = 0;

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Triad Fast Market Arb v1");
console.log("═══════════════════════════════════════════════════════");
console.log(`[TRIAD] Wallet:       ${WALLET}`);
console.log(`[TRIAD] Amount/trade: $${ARB_AMOUNT}`);
console.log(`[TRIAD] Min profit:   $${MIN_NET_PROFIT}`);
console.log(`[TRIAD] Scan:         ${SCAN_INTERVAL_MS}ms`);
console.log(`[TRIAD] API:          ${TRIAD_API}`);
console.log(`[TRIAD] Dry run:      ${DRY_RUN}`);
console.log(`[TRIAD] Strategy:     Sum-to-One MERGE (Hype + Flop)`);
console.log(`[TRIAD] Pools:        ${FAST_MARKET_POOLS.map(p => p.coin).join(", ")}`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface TriadMarket {
  id: string;
  authority: string;
  marketAddress: string;
  timestamp: number;
  mint: string;
  payoutFee: number;
  marketStart: number;
  marketEnd: number;
  question: string;
  winningDirection: string; // "None" = still open, "Hype" or "Flop" = resolved
  isFast: boolean;
  isAllowedToPayout: boolean;
  hypePrice: number;
  flopPrice: number;
  totalVolume: number;
  openBets: number;
  hypeLiquidity: number;
  flopLiquidity: number;
  hypeShares: number;
  flopShares: number;
  volume: number;
}

interface TriadPool {
  id: string;
  question: string;
  coin: string;
  volume: number;
  markets: TriadMarket[];
}

interface TriadOrderbook {
  marketId: number;
  hype: { bid: OrderbookLevel[]; ask: OrderbookLevel[] };
  flop: { bid: OrderbookLevel[]; ask: OrderbookLevel[] };
  spreadToReward: string;
}

interface OrderbookLevel {
  price: number;
  size: number;
}

interface ArbCandidate {
  pool: { poolId: string; coin: string };
  market: TriadMarket;
  hypeAsk: number;   // Best ask price for Hype (YES/Up)
  flopAsk: number;   // Best ask price for Flop (NO/Down)
  totalAsk: number;
  mergeSpread: number; // 1 - totalAsk
  netProfit: number;
  remaining: number;  // seconds until close
  isNewWindow: boolean;
  hasOrderbookLiquidity: boolean;
}

// ── Triad API helpers ───────────────────────────────────
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

async function fetchPool(poolId: string): Promise<TriadPool | null> {
  try {
    const res = await fetch(`${TRIAD_API}/market/${poolId}?lang=en-US`, { headers: TRIAD_HEADERS });
    if (!res.ok) {
      console.error(`[TRIAD] Pool ${poolId} fetch failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[TRIAD] Pool ${poolId} error:`, err);
    return null;
  }
}

async function fetchOrderbook(marketId: string): Promise<TriadOrderbook | null> {
  try {
    const res = await fetch(`${TRIAD_API}/market/${marketId}/orderbook`, { headers: TRIAD_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Scan for arb candidates ─────────────────────────────
async function findArbCandidates(): Promise<ArbCandidate[]> {
  const candidates: ArbCandidate[] = [];
  const now = Date.now() / 1000;

  // Fetch all pools in parallel
  const poolResults = await Promise.all(
    FAST_MARKET_POOLS.map(async (p) => {
      const pool = await fetchPool(p.poolId);
      return { config: p, pool };
    })
  );

  for (const { config, pool } of poolResults) {
    if (!pool?.markets) continue;

    for (const market of pool.markets) {
      marketsSeenTotal++;

      // Only open markets (winningDirection = "None")
      if (market.winningDirection !== "None") continue;
      if (!market.isFast) continue;

      const remaining = market.marketEnd - now;
      if (remaining < 30 || remaining > 6 * 60) continue; // 30s to 6min remaining

      // Skip cooldown
      if (marketCooldowns.has(market.id) && Date.now() - marketCooldowns.get(market.id)! < COOLDOWN_MS) continue;

      // Check on-chain prices first (from API)
      let hypeAsk = market.hypePrice;
      let flopAsk = market.flopPrice;

      // Try to get better prices from orderbook
      const orderbook = await fetchOrderbook(market.id);
      let hasOrderbookLiquidity = false;

      if (orderbook) {
        // Best ask = cheapest price to buy
        if (orderbook.hype.ask.length > 0) {
          hypeAsk = Math.min(...orderbook.hype.ask.map(l => l.price));
          hasOrderbookLiquidity = true;
        }
        if (orderbook.flop.ask.length > 0) {
          flopAsk = Math.min(...orderbook.flop.ask.map(l => l.price));
          hasOrderbookLiquidity = true;
        }
      }

      if (hypeAsk <= 0 || flopAsk <= 0) continue;

      const totalAsk = hypeAsk + flopAsk;
      const mergeSpread = 1 - totalAsk;

      // Track best spread even if not profitable
      if (mergeSpread > bestSpreadSeen) bestSpreadSeen = mergeSpread;

      if (mergeSpread <= 0) continue; // No opportunity

      // Calculate profitability
      const payout = ARB_AMOUNT; // $1.00 per contract
      const totalCost = totalAsk * ARB_AMOUNT;
      const payoutFeeRate = market.payoutFee || 0;
      const fees = totalCost * payoutFeeRate;
      const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD; // ~$0.30
      const grossProfit = payout - totalCost;
      const netProfit = grossProfit - fees - txFeeUsd;

      if (netProfit < MIN_NET_PROFIT) continue;

      const isNewWindow = (now - market.marketStart) < 30;

      candidates.push({
        pool: config,
        market,
        hypeAsk,
        flopAsk,
        totalAsk,
        mergeSpread,
        netProfit,
        remaining,
        isNewWindow,
        hasOrderbookLiquidity,
      });
    }
  }

  return candidates.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute MERGE arb ───────────────────────────────────
async function executeMerge(candidate: ArbCandidate): Promise<void> {
  const { market, netProfit, hypeAsk, flopAsk, totalAsk, pool } = candidate;

  console.log(`\n[TRIAD-ARB] ═══ EXECUTING MERGE ═══════════════════════`);
  console.log(`[TRIAD-ARB] ${pool.coin}: ${market.question}`);
  console.log(`[TRIAD-ARB] Market: ${market.marketAddress}`);
  console.log(`[TRIAD-ARB] Hype=$${hypeAsk.toFixed(4)} + Flop=$${flopAsk.toFixed(4)} = $${totalAsk.toFixed(4)}`);
  console.log(`[TRIAD-ARB] Spread: ${(candidate.mergeSpread * 100).toFixed(3)}%`);
  console.log(`[TRIAD-ARB] Est. net profit: $${netProfit.toFixed(4)}`);
  console.log(`[TRIAD-ARB] Time remaining: ${Math.round(candidate.remaining)}s`);
  console.log(`[TRIAD-ARB] Orderbook liquidity: ${candidate.hasOrderbookLiquidity}`);

  if (DRY_RUN) {
    console.log(`[TRIAD-ARB] 🏜️ DRY RUN — would execute, skipping`);
    marketCooldowns.set(market.id, Date.now());
    return;
  }

  // Log to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: market.id,
      market_b_id: market.id,
      side_a: "triad_hype",
      side_b: "triad_flop",
      price_a: hypeAsk,
      price_b: flopAsk,
      spread: candidate.mergeSpread,
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id;

  try {
    // TODO: Build on-chain transaction using Triad program
    // Program: TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss
    // Need to:
    // 1. Create "open_position" instruction for Hype side
    // 2. Create "open_position" instruction for Flop side
    // 3. Bundle both in a Jito atomic bundle
    //
    // For now, log the opportunity and mark as pending
    console.log(`[TRIAD-ARB] ⚠️ On-chain execution not yet implemented`);
    console.log(`[TRIAD-ARB] Market address: ${market.marketAddress}`);
    console.log(`[TRIAD-ARB] Program: ${TRIAD_PROGRAM_ID.toBase58()}`);

    if (oppId) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppId,
        amount_usd: totalAsk * ARB_AMOUNT,
        realized_pnl: 0,
        fees: 0,
        status: "pending",
        error_message: "On-chain execution pending implementation",
      });
      await supabase.from("arb_opportunities").update({ status: "detected" }).eq("id", oppId);
    }

    marketCooldowns.set(market.id, Date.now());
  } catch (err) {
    console.error("[TRIAD-ARB] ❌ Execution error:", err);
    if (oppId) {
      await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
    }
  }
}

// ── Main Scan Loop ──────────────────────────────────────
async function runScan(): Promise<boolean> {
  let hasNewWindows = false;
  try {
    scanCount++;
    const verbose = scanCount % 10 === 0;

    if (verbose) {
      console.log(`\n[SCAN] #${scanCount} ${new Date().toISOString()} ─────────────────`);
    }

    const candidates = await findArbCandidates();

    if (candidates.length === 0) {
      if (verbose) {
        console.log(`[SCAN] No profitable fast markets found`);
        console.log(`  📈 Best spread seen: ${bestSpreadSeen === -Infinity ? "N/A" : (bestSpreadSeen * 100).toFixed(3) + "%"}`);
        console.log(`  📊 Markets scanned total: ${marketsSeenTotal}`);
      }
      return false;
    }

    hasNewWindows = candidates.some((c) => c.isNewWindow);

    console.log(`\n[SCAN] 🎯 FOUND ${candidates.length} opportunities!`);
    for (const c of candidates.slice(0, 5)) {
      const icon = c.isNewWindow ? "🆕" : "💰";
      console.log(
        `  ${icon} ${c.pool.coin} "${c.market.question}" ` +
        `hype=$${c.hypeAsk.toFixed(4)} flop=$${c.flopAsk.toFixed(4)} ` +
        `spread=${(c.mergeSpread * 100).toFixed(2)}% ` +
        `net=$${c.netProfit.toFixed(4)} rem=${Math.round(c.remaining)}s` +
        `${c.hasOrderbookLiquidity ? " 📖" : ""}`
      );
    }

    // Track best spread
    for (const c of candidates) {
      if (c.mergeSpread > bestSpreadSeen) bestSpreadSeen = c.mergeSpread;
    }

    // Execute top opportunity
    const best = candidates[0];
    await executeMerge(best);
    await sleep(500);

    // Upsert to prediction_markets (every 10 scans)
    if (verbose) {
      const upserts = candidates.slice(0, 20).map((c) => ({
        platform: "triad" as const,
        external_id: c.market.id,
        question: `${c.pool.coin}: ${c.market.question}`,
        yes_price: c.hypeAsk,
        no_price: c.flopAsk,
        volume: c.market.volume || 0,
        end_date: new Date(c.market.marketEnd * 1000).toISOString(),
        category: "crypto",
        url: `https://triadfi.co/market/${c.market.id}`,
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

// ── Adaptive loop ───────────────────────────────────────
async function scanLoop() {
  while (true) {
    const hasNewWindows = await runScan();
    const delay = hasNewWindows ? FAST_SCAN_MS : SCAN_INTERVAL_MS;
    await sleep(delay);
  }
}

// ── Pool Discovery ──────────────────────────────────────
// Try to discover additional fast market pool IDs dynamically
async function discoverPools(): Promise<void> {
  console.log("[TRIAD] Discovering fast market pools...");

  // Try pool IDs around the known ones
  const tryIds = Array.from({ length: 20 }, (_, i) => String(160 + i));
  const results = await Promise.allSettled(
    tryIds.map(async (id) => {
      const res = await fetch(`${TRIAD_API}/market/${id}?lang=en-US`, { headers: TRIAD_HEADERS });
      if (!res.ok) return null;
      const data: TriadPool = await res.json();
      if (data.markets?.some(m => m.isFast)) {
        return { id, coin: data.coin, question: data.question, marketCount: data.markets.length };
      }
      return null;
    })
  );

  const discovered: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const p = r.value;
      discovered.push(`  Pool ${p.id}: ${p.coin} — "${p.question}" (${p.marketCount} markets)`);

      // Add to scan list if not already there
      if (!FAST_MARKET_POOLS.find(fp => fp.poolId === p.id)) {
        FAST_MARKET_POOLS.push({
          poolId: p.id,
          coin: p.coin || "???",
          name: p.question || `Pool ${p.id}`,
        });
      }
    }
  }

  if (discovered.length > 0) {
    console.log(`[TRIAD] ✅ Discovered ${discovered.length} fast market pools:`);
    discovered.forEach(d => console.log(d));
  } else {
    console.log("[TRIAD] No additional fast market pools found in range 160-179");
  }

  console.log(`[TRIAD] Scanning ${FAST_MARKET_POOLS.length} pools: ${FAST_MARKET_POOLS.map(p => `${p.coin}(${p.poolId})`).join(", ")}`);
}

// ── Start ───────────────────────────────────────────────
async function main() {
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`[TRIAD] SOL balance: ${(balance / 1e9).toFixed(4)}`);

    if (balance < 0.005 * 1e9) {
      console.error("[TRIAD] ❌ Insufficient SOL — need ≥ 0.005 SOL");
      process.exit(1);
    }

    // Verify Triad API access
    const testRes = await fetch(`${TRIAD_API}/points/levels`, { headers: TRIAD_HEADERS });
    if (!testRes.ok) {
      console.error(`[TRIAD] ❌ Cannot reach Triad API: ${testRes.status}`);
      process.exit(1);
    }
    console.log("[TRIAD] ✅ Triad API reachable");

    // Discover available fast market pools
    await discoverPools();

    console.log("[TRIAD] Starting scan loop...\n");
    await scanLoop();
  } catch (err) {
    console.error("[TRIAD] Fatal error:", err);
    process.exit(1);
  }
}

main().catch(console.error);
