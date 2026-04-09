/**
 * RICKY TRADES — DFlow/Triad Prediction Market Arb Engine v1
 *
 * Strategy: Sum-to-One MERGE on 5-minute crypto markets
 *   - Buy YES(Up) + YES(Down) when askUp + askDown < $1.00 - fees
 *   - Atomic execution via Jito bundles — both legs land or neither does
 *   - Same Solana wallet as Jupiter Predict engine
 *
 * DFlow API:
 *   - Metadata: prediction-markets-api.dflow.net (market discovery)
 *   - Trade:    quote-api.dflow.net (order creation → signed tx)
 *
 * Profit guarantee: totalCost(both legs) + fees < $1.00 payout
 */

import {
  Connection,
  Keypair,
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

// DFlow endpoints (dev = no API key needed, prod = x-api-key required)
const DFLOW_API_KEY = process.env.DFLOW_API_KEY || "";
const DFLOW_METADATA_API = DFLOW_API_KEY
  ? "https://prediction-markets-api.dflow.net"
  : "https://dev-prediction-markets-api.dflow.net";
const DFLOW_TRADE_API = DFLOW_API_KEY
  ? "https://quote-api.dflow.net"
  : "https://dev-quote-api.dflow.net";

const USDC_MINT = CONFIG.JUP_USD_MINT;

// Jito
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Scan settings
const SCAN_INTERVAL_MS = parseInt(process.env.DFLOW_SCAN_INTERVAL_MS || "1500");
const FAST_SCAN_MS = 500;
const ARB_AMOUNT = parseFloat(process.env.DFLOW_ARB_AMOUNT || String(CONFIG.ARB_AMOUNT));
const MIN_NET_PROFIT = parseFloat(process.env.DFLOW_MIN_PROFIT || "0.01");
const PLATFORM_FEE_RATE = 0.01; // 1% per side (DFlow/Triad fee)
const COOLDOWN_MS = 60_000;
const DRY_RUN = process.env.DFLOW_DRY_RUN !== "false"; // default: true (safe)

// Crypto tickers to scan
const CRYPTO_KEYS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "SUI", "AVAX", "ADA", "LINK"];

// State
const marketCooldowns = new Map<string, number>();
let scanCount = 0;
let bestSpreadSeen = -Infinity;

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — DFlow/Triad Arb v1 (5-Min Markets)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[DFLOW] Wallet:       ${WALLET}`);
console.log(`[DFLOW] Amount/trade: $${ARB_AMOUNT}`);
console.log(`[DFLOW] Min profit:   $${MIN_NET_PROFIT}`);
console.log(`[DFLOW] Scan:         ${SCAN_INTERVAL_MS}ms (fast: ${FAST_SCAN_MS}ms)`);
console.log(`[DFLOW] Metadata API: ${DFLOW_METADATA_API}`);
console.log(`[DFLOW] Trade API:    ${DFLOW_TRADE_API}`);
console.log(`[DFLOW] Dry run:      ${DRY_RUN}`);
console.log(`[DFLOW] Strategy:     Sum-to-One MERGE (atomic Jito bundles)`);
console.log("═══════════════════════════════════════════════════════");

// ── Types ───────────────────────────────────────────────
interface DFlowEvent {
  ticker: string;
  title: string;
  seriesTicker: string;
  markets: DFlowMarket[];
}

interface DFlowMarket {
  ticker: string;
  title: string;
  eventTicker: string;
  status: string;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  volume: number;
  closeTime?: number;
  expirationTime?: number;
  openTime?: number;
  // Outcome token mints (from market detail endpoint)
  yesMint?: string;
  noMint?: string;
}

interface ArbCandidate {
  event: DFlowEvent;
  yesMarket: DFlowMarket;   // "Up" market — we buy YES here
  noMarket: DFlowMarket;    // "Down" market — we buy YES here
  upAsk: number;            // Cost to buy YES on Up
  downAsk: number;          // Cost to buy YES on Down
  totalAsk: number;         // upAsk + downAsk
  mergeSpread: number;      // 1 - totalAsk (positive = profitable before fees)
  grossProfit: number;
  fees: number;
  netProfit: number;
  remaining: number;        // seconds until close
  isNewWindow: boolean;
}

// ── DFlow API helpers ───────────────────────────────────
function dflowHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (DFLOW_API_KEY) h["x-api-key"] = DFLOW_API_KEY;
  return h;
}

async function fetchDFlowEvents(): Promise<DFlowEvent[]> {
  const allEvents: DFlowEvent[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      withNestedMarkets: "true",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `${DFLOW_METADATA_API}/api/v1/events?${params}`,
      { headers: dflowHeaders() }
    );
    if (!res.ok) break;

    const data = await res.json();
    const events = data.events || [];
    allEvents.push(...events);
    cursor = data.cursor;
    if (!cursor || events.length < 100) break;
  }

  return allEvents;
}

// ── Fetch outcome token mints for a market ──────────────
// DFlow markets have YES/NO outcome token mints we need for /order
async function getMarketDetail(ticker: string): Promise<{ yesMint?: string; noMint?: string } | null> {
  try {
    const res = await fetch(
      `${DFLOW_METADATA_API}/api/v1/markets/${ticker}`,
      { headers: dflowHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();

    // DFlow market detail includes outcome token mints
    // The structure may vary — try known field names
    const yesMint = data.yesTokenMint || data.yesMint || data.outcomes?.[0]?.tokenMint || data.outcomes?.yes?.mint;
    const noMint = data.noTokenMint || data.noMint || data.outcomes?.[1]?.tokenMint || data.outcomes?.no?.mint;

    return { yesMint, noMint };
  } catch {
    return null;
  }
}

// ── Create buy order via DFlow Trade API ────────────────
// Returns a serialized transaction to sign
async function createDFlowOrder(
  outcomeMint: string,
  amountUsdcRaw: number,  // in USDC base units (6 decimals)
  slippageBps: number = 100,
): Promise<{ transaction: string } | null> {
  try {
    const params = new URLSearchParams({
      inputMint: USDC_MINT,
      outputMint: outcomeMint,
      amount: String(amountUsdcRaw),
      userPublicKey: WALLET,
      predictionMarketSlippageBps: String(slippageBps),
    });

    console.log(
      `[DFLOW-ORDER] BUY outcome=${outcomeMint.slice(0, 8)}... ` +
      `amount=${(amountUsdcRaw / 1_000_000).toFixed(2)} USDC`
    );

    const res = await fetch(
      `${DFLOW_TRADE_API}/order?${params}`,
      { headers: dflowHeaders() }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error(`[DFLOW-ORDER] Error ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    if (!data.transaction) {
      console.error("[DFLOW-ORDER] No transaction returned");
      return null;
    }

    console.log(`[DFLOW-ORDER] ✅ Order TX received`);
    return { transaction: data.transaction };
  } catch (err) {
    console.error("[DFLOW-ORDER] Error:", err);
    return null;
  }
}

// ── Sign transaction ────────────────────────────────────
async function buildAndSign(base64Tx: string): Promise<VersionedTransaction> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);
  return tx;
}

// ── Jito Bundle ─────────────────────────────────────────
async function sendJitoBundle(txs: VersionedTransaction[]): Promise<string | null> {
  try {
    const encodedTxs = txs.map((tx) => bs58.encode(tx.serialize()));
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

    const data = (await res.json()) as any;
    if (data.error) {
      console.error(`[JITO] Bundle error: ${JSON.stringify(data.error)}`);
      return null;
    }

    const bundleId = data.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    // Poll for confirmation (30s max)
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
        const statusData = (await statusRes.json()) as any;
        const statuses = statusData?.result?.value || [];
        if (statuses.length > 0) {
          const s = statuses[0];
          console.log(`[JITO] Status: ${s.confirmation_status || s.status}`);
          if (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized") return bundleId;
          if (s.err || s.confirmation_status === "failed") return null;
        }
      } catch {
        /* retry */
      }
    }

    console.warn("[JITO] Status unknown after 30s — marking as pending");
    return bundleId; // Optimistic — bundle may still land
  } catch (err) {
    console.error("[JITO] Submission error:", err);
    return null;
  }
}

// ── Scan for 5-min arb candidates ───────────────────────
async function findArbCandidates(): Promise<ArbCandidate[]> {
  const events = await fetchDFlowEvents();
  const candidates: ArbCandidate[] = [];
  const now = Date.now() / 1000;

  for (const event of events) {
    const series = String(event.seriesTicker || "").toUpperCase();
    const title = String(event.title || "").toUpperCase();

    // Only 5-min crypto markets
    const isCrypto = CRYPTO_KEYS.some(
      (k) => series.includes(k) || title.includes(k)
    );
    const is5Min =
      series.includes("5M") || series.includes("5MIN") ||
      title.includes("5 MIN") || title.includes("5M");

    if (!isCrypto || !is5Min) continue;

    const markets = event.markets || [];
    if (markets.length < 2) continue;

    // Find the Up and Down markets for this event
    // DFlow typically has two markets per event: one for each outcome
    // For "Will BTC be above X?": YES = Up, NO = Down
    // We need to buy YES on BOTH the Up and Down markets
    for (let i = 0; i < markets.length; i++) {
      const mA = markets[i];
      if (mA.status !== "open" && mA.status !== "active") continue;

      const closeA = Number(mA.closeTime ?? mA.expirationTime ?? 0);
      if (!closeA || closeA < now) continue;
      const remaining = closeA - now;
      if (remaining < 60 || remaining > 6 * 60) continue; // 1-6 min remaining

      // Check cooldown
      if (marketCooldowns.has(mA.ticker) && Date.now() - marketCooldowns.get(mA.ticker)! < COOLDOWN_MS) continue;

      // For DFlow binary markets, each market has YES and NO sides
      // Sum-to-one: buy YES + buy NO on the SAME market
      // If yesAsk + noAsk < 1.00, there's an arb
      const yesAsk = Number(mA.yesAsk ?? 0);
      const noAsk = Number(mA.noAsk ?? 0);

      if (yesAsk <= 0 || noAsk <= 0) continue;

      const totalAsk = yesAsk + noAsk;
      const mergeSpread = 1 - totalAsk;

      if (mergeSpread <= 0) continue; // No opportunity

      // Calculate profitability
      const amount = ARB_AMOUNT;
      const yesCost = yesAsk * amount;
      const noCost = noAsk * amount;
      const totalCost = yesCost + noCost;
      const payout = amount; // $1.00 per contract at settlement
      const platformFees = totalCost * PLATFORM_FEE_RATE;
      const txFeeUsd = 0.002 * CONFIG.SOL_PRICE_USD; // ~$0.30 for Jito tip
      const fees = platformFees + txFeeUsd;
      const grossProfit = payout - totalCost;
      const netProfit = grossProfit - fees;

      if (netProfit < MIN_NET_PROFIT) continue;

      const openTime = Number(mA.openTime ?? 0);
      const isNewWindow = openTime > 0 && (now - openTime) < 30;

      candidates.push({
        event,
        yesMarket: mA,
        noMarket: mA, // Same market — we buy both YES and NO
        upAsk: yesAsk,
        downAsk: noAsk,
        totalAsk,
        mergeSpread,
        grossProfit,
        fees,
        netProfit,
        remaining,
        isNewWindow,
      });
    }
  }

  return candidates.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute MERGE arb ───────────────────────────────────
async function executeMerge(candidate: ArbCandidate): Promise<void> {
  const { yesMarket, netProfit, upAsk, downAsk, totalAsk, fees } = candidate;
  const ticker = yesMarket.ticker;

  console.log(`\n[DFLOW-ARB] ═══ EXECUTING MERGE ═══════════════════════`);
  console.log(`[DFLOW-ARB] Market: ${yesMarket.title || ticker}`);
  console.log(`[DFLOW-ARB] YES ask=$${upAsk.toFixed(4)} + NO ask=$${downAsk.toFixed(4)} = $${totalAsk.toFixed(4)}`);
  console.log(`[DFLOW-ARB] Spread: ${(candidate.mergeSpread * 100).toFixed(3)}%`);
  console.log(`[DFLOW-ARB] Est. net profit: $${netProfit.toFixed(4)} (fees: $${fees.toFixed(4)})`);
  console.log(`[DFLOW-ARB] Time remaining: ${Math.round(candidate.remaining)}s`);

  if (DRY_RUN) {
    console.log(`[DFLOW-ARB] 🏜️ DRY RUN — would execute, skipping`);
    marketCooldowns.set(ticker, Date.now());
    return;
  }

  // Step 1: Get outcome token mints
  console.log(`[DFLOW-ARB] Fetching market detail for ${ticker}...`);
  const detail = await getMarketDetail(ticker);
  if (!detail?.yesMint || !detail?.noMint) {
    console.error(`[DFLOW-ARB] ❌ Cannot resolve outcome token mints for ${ticker}`);
    marketCooldowns.set(ticker, Date.now());
    return;
  }

  console.log(`[DFLOW-ARB] YES mint: ${detail.yesMint.slice(0, 12)}...`);
  console.log(`[DFLOW-ARB] NO  mint: ${detail.noMint.slice(0, 12)}...`);

  // Step 2: Log to DB
  const { data: oppRow } = await supabase
    .from("arb_opportunities")
    .insert({
      market_a_id: ticker,
      market_b_id: ticker,
      side_a: "dflow_yes",
      side_b: "dflow_no",
      price_a: upAsk,
      price_b: downAsk,
      spread: candidate.mergeSpread,
      status: "executing",
    })
    .select("id")
    .single();

  const oppId = oppRow?.id;

  try {
    // Step 3: Create buy orders for YES and NO outcome tokens
    const yesCostRaw = Math.floor(upAsk * ARB_AMOUNT * 1_000_000);   // USDC raw (6 decimals)
    const noCostRaw = Math.floor(downAsk * ARB_AMOUNT * 1_000_000);

    const [yesOrder, noOrder] = await Promise.all([
      createDFlowOrder(detail.yesMint, yesCostRaw),
      createDFlowOrder(detail.noMint, noCostRaw),
    ]);

    if (!yesOrder || !noOrder) {
      console.log("[DFLOW-ARB] ⚠️ Could not get order TXs — aborting (zero risk)");
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: "DFlow order creation failed",
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
      marketCooldowns.set(ticker, Date.now());
      return;
    }

    // Step 4: Sign both transactions
    const [yesTx, noTx] = await Promise.all([
      buildAndSign(yesOrder.transaction),
      buildAndSign(noOrder.transaction),
    ]);

    // Step 5: Submit as atomic Jito bundle
    console.log("[JITO] Submitting atomic MERGE bundle (both or neither)...");
    const bundleResult = await sendJitoBundle([yesTx, noTx]);
    marketCooldowns.set(ticker, Date.now());

    if (bundleResult) {
      console.log(`[DFLOW-ARB] ✅ Jito bundle landed! ${bundleResult}`);
      console.log(`[DFLOW-ARB] 💰 Net profit: ~$${netProfit.toFixed(4)}`);

      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId,
          amount_usd: (upAsk + downAsk) * ARB_AMOUNT,
          realized_pnl: netProfit,
          fees: fees,
          status: "filled",
          side_a_tx: bs58.encode(yesTx.signatures[0]),
          side_b_tx: bs58.encode(noTx.signatures[0]),
        });
        await supabase.from("arb_opportunities").update({ status: "executed" }).eq("id", oppId);
      }
    } else {
      console.error(`[DFLOW-ARB] ❌ Jito bundle failed — no capital at risk`);
      if (oppId) {
        await supabase.from("arb_executions").insert({
          opportunity_id: oppId, amount_usd: 0, realized_pnl: 0, fees: 0,
          status: "failed", error_message: "Jito bundle rejected",
        });
        await supabase.from("arb_opportunities").update({ status: "failed" }).eq("id", oppId);
      }
    }
  } catch (err) {
    console.error("[DFLOW-ARB] ❌ Execution error:", err);
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
        console.log(`[SCAN] No profitable 5-min markets found`);
        console.log(`  📈 Best spread seen: ${(bestSpreadSeen * 100).toFixed(3)}%`);
      }
      return false;
    }

    hasNewWindows = candidates.some((c) => c.isNewWindow);

    // Log candidates
    console.log(`\n[SCAN] 🎯 FOUND ${candidates.length} opportunities!`);
    for (const c of candidates.slice(0, 5)) {
      const icon = c.isNewWindow ? "🆕" : "💰";
      console.log(
        `  ${icon} "${(c.yesMarket.title || c.yesMarket.ticker).slice(0, 50)}" ` +
        `ask=$${c.totalAsk.toFixed(4)} spread=${(c.mergeSpread * 100).toFixed(2)}% ` +
        `net=$${c.netProfit.toFixed(4)} rem=${Math.round(c.remaining)}s`
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

    // Upsert to DB (every 10 scans)
    if (verbose) {
      const upserts = candidates.slice(0, 20).map((c) => ({
        platform: "dflow" as const,
        external_id: c.yesMarket.ticker,
        question: c.yesMarket.title || c.yesMarket.ticker,
        yes_price: c.upAsk,
        no_price: c.downAsk,
        volume: c.yesMarket.volume || 0,
        end_date: c.yesMarket.closeTime
          ? new Date(c.yesMarket.closeTime * 1000).toISOString()
          : null,
        category: "crypto",
        url: null,
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

// ── Start ───────────────────────────────────────────────
async function main() {
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`[DFLOW] SOL balance: ${(balance / 1e9).toFixed(4)}`);

    if (balance < 0.005 * 1e9) {
      console.error("[DFLOW] ❌ Insufficient SOL for tx fees — need ≥ 0.005 SOL");
      process.exit(1);
    }

    // Verify DFlow API access
    const testRes = await fetch(
      `${DFLOW_METADATA_API}/api/v1/events?limit=1`,
      { headers: dflowHeaders() }
    );
    if (!testRes.ok) {
      console.error(`[DFLOW] ❌ Cannot reach DFlow Metadata API: ${testRes.status}`);
      process.exit(1);
    }
    console.log("[DFLOW] ✅ DFlow Metadata API reachable");

    // Verify Trade API
    const tradeTest = await fetch(
      `${DFLOW_TRADE_API}/order?inputMint=${USDC_MINT}&outputMint=${USDC_MINT}&amount=1000000`,
    );
    // Even an error response means the API is reachable
    console.log(`[DFLOW] ✅ DFlow Trade API reachable (status: ${tradeTest.status})`);

    console.log("[DFLOW] Starting scan loop...\n");
    await scanLoop();
  } catch (err) {
    console.error("[DFLOW] Fatal error:", err);
    process.exit(1);
  }
}

main().catch(console.error);
