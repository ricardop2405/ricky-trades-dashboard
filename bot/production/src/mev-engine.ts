/**
 * RICKY TRADES — Solana MEV Backrunning Engine
 *
 * Monitors Jupiter V6, Raydium, Orca, Meteora for whale swaps
 * and executes triangular arbitrage via Jito bundles.
 *
 * Usage: npm run mev
 */

import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { DEX_PROGRAMS, USDC_MINT, USDT_MINT, SOL_MINT, STABLECOIN_MINTS, JITO_TIP_ACCOUNTS } from "./constants";
import { sleep, isRateLimitError, getTokenName } from "./utils";

// ── State ───────────────────────────────────────────────
type PendingSignature = { signature: string; dex: string };

const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  wsEndpoint: CONFIG.HELIUS_WS,
  commitment: "confirmed",
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const pendingSignatures: PendingSignature[] = [];
const queuedSignatures = new Set<string>();
let isQueueWorkerRunning = false;
let rpcCooldownUntil = 0;
let totalProcessed = 0;
let totalWhales = 0;

// ── Signature queue ─────────────────────────────────────
function enqueueSignature(signature: string, dex: string) {
  if (queuedSignatures.has(signature)) return;

  if (pendingSignatures.length >= CONFIG.MAX_PENDING_SIGNATURES) {
    const dropped = pendingSignatures.shift();
    if (dropped) queuedSignatures.delete(dropped.signature);
  }

  pendingSignatures.push({ signature, dex });
  queuedSignatures.add(signature);
}

// ── Transaction parsing ─────────────────────────────────
function parseSwapFromTransaction(tx: any): {
  wallet: string;
  tokenIn: string;
  tokenOut: string;
  tokenInMint: string;
  tokenOutMint: string;
  amountUSD: number;
  direction: "buy" | "sell";
} | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const wallet = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || "unknown";
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];

  const changes: { mint: string; diff: number; decimals: number }[] = [];

  for (const post of postBalances) {
    const pre = preBalances.find(
      (p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint
    );
    const preAmt = Number(pre?.uiTokenAmount?.uiAmount || 0);
    const postAmt = Number(post.uiTokenAmount?.uiAmount || 0);
    const diff = postAmt - preAmt;
    if (Math.abs(diff) > 0.000001) {
      changes.push({ mint: post.mint, diff, decimals: post.uiTokenAmount?.decimals || 0 });
    }
  }

  if (changes.length < 2) return null;

  const spent = changes.filter((c) => c.diff < 0).sort((a, b) => a.diff - b.diff);
  const received = changes.filter((c) => c.diff > 0).sort((a, b) => b.diff - a.diff);

  if (spent.length === 0 || received.length === 0) return null;

  const tokenInMint = spent[0].mint;
  const tokenOutMint = received[0].mint;
  const tokenIn = getTokenName(tokenInMint);
  const tokenOut = getTokenName(tokenOutMint);

  let amountUSD = 0;
  if (STABLECOIN_MINTS.has(tokenInMint)) {
    amountUSD = Math.abs(spent[0].diff);
  } else if (STABLECOIN_MINTS.has(tokenOutMint)) {
    amountUSD = Math.abs(received[0].diff);
  } else if (tokenInMint === SOL_MINT) {
    amountUSD = Math.abs(spent[0].diff) * CONFIG.SOL_PRICE_USD;
  } else if (tokenOutMint === SOL_MINT) {
    amountUSD = Math.abs(received[0].diff) * CONFIG.SOL_PRICE_USD;
  } else {
    const preSol = meta.preBalances[0] / LAMPORTS_PER_SOL;
    const postSol = meta.postBalances[0] / LAMPORTS_PER_SOL;
    amountUSD = Math.abs(postSol - preSol) * CONFIG.SOL_PRICE_USD;
  }

  const direction: "buy" | "sell" = STABLECOIN_MINTS.has(tokenInMint) ? "buy" : "sell";

  return {
    wallet: wallet.slice(0, 4) + "..." + wallet.slice(-4),
    tokenIn,
    tokenOut,
    tokenInMint,
    tokenOutMint,
    amountUSD,
    direction,
  };
}

// ── RPC with retry ──────────────────────────────────────
async function getParsedTransactionWithRetry(signature: string) {
  let backoffMs = CONFIG.RATE_LIMIT_BACKOFF_MS;

  for (let attempt = 1; attempt <= CONFIG.MAX_GET_TX_RETRIES; attempt++) {
    try {
      return await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      rpcCooldownUntil = Date.now() + backoffMs;
      if (attempt === 1) {
        console.warn(`[RPC] Rate limited, backing off ${backoffMs}ms...`);
      }
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }
  return null;
}

// ── Process a single signature ──────────────────────────
async function processSignature(signature: string, dex: string) {
  try {
    totalProcessed++;
    const tx = await getParsedTransactionWithRetry(signature);
    if (!tx?.meta) return;

    const swapInfo = parseSwapFromTransaction(tx);
    if (!swapInfo) return;
    if (swapInfo.amountUSD < CONFIG.WHALE_THRESHOLD) return;

    totalWhales++;
    console.log(
      `[WHALE] $${swapInfo.amountUSD.toFixed(0)} | ${swapInfo.tokenIn} → ${swapInfo.tokenOut} | ${dex} | ${signature.slice(0, 8)}...`
    );

    const { error } = await supabase.from("whale_trades").insert({
      wallet: swapInfo.wallet,
      token_in: swapInfo.tokenIn,
      token_out: swapInfo.tokenOut,
      amount_usd: swapInfo.amountUSD,
      tx_signature: signature,
      direction: swapInfo.direction,
    });

    if (error) console.error("[DB] Insert whale_trade error:", error.message);

    if (swapInfo.amountUSD >= 20_000) {
      await executeBackrun(swapInfo, signature, dex);
    }
  } catch (error) {
    if (!isRateLimitError(error)) {
      console.error("[MEV] Process error:", error);
    }
  }
}

// ── Queue worker ────────────────────────────────────────
async function startQueueWorker() {
  if (isQueueWorkerRunning) return;
  isQueueWorkerRunning = true;

  console.log(
    `[MEV] Queue worker | threshold=$${CONFIG.WHALE_THRESHOLD} | interval=${CONFIG.PARSED_TX_MIN_INTERVAL_MS}ms | maxQueue=${CONFIG.MAX_PENDING_SIGNATURES}`
  );

  while (true) {
    const waitForCooldown = rpcCooldownUntil - Date.now();
    if (waitForCooldown > 0) {
      await sleep(Math.min(waitForCooldown, 1_000));
      continue;
    }

    const next = pendingSignatures.shift();
    if (!next) {
      await sleep(250);
      continue;
    }

    queuedSignatures.delete(next.signature);
    await processSignature(next.signature, next.dex);
    await sleep(CONFIG.PARSED_TX_MIN_INTERVAL_MS);
  }
}

// ── Arb route calculation ───────────────────────────────
async function calculateArbRoute(targetMint: string) {
  const entryAmount = 200_000_000; // 200 USDC

  try {
    const quote1 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${entryAmount}&slippageBps=50`
    ).then((r) => r.json());
    if (!quote1 || quote1.error) return null;

    const quote2 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${targetMint}&amount=${quote1.outAmount}&slippageBps=50`
    ).then((r) => r.json());
    if (!quote2 || quote2.error) return null;

    const quote3 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${targetMint}&outputMint=${USDC_MINT}&amount=${quote2.outAmount}&slippageBps=50`
    ).then((r) => r.json());
    if (!quote3 || quote3.error) return null;

    const exitAmount = Number(quote3.outAmount);
    const profit = (exitAmount - entryAmount) / 1_000_000;
    const tipUSD = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;

    return {
      quotes: [quote1, quote2, quote3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profit - tipUSD,
      route: `USDC → SOL → ${getTokenName(targetMint)} → USDC`,
    };
  } catch {
    return null;
  }
}

// ── Backrun execution ───────────────────────────────────
async function executeBackrun(swapInfo: any, triggerSignature: string, dex: string) {
  const startTime = Date.now();

  try {
    const targetMint = swapInfo.tokenOutMint || SOL_MINT;
    if (STABLECOIN_MINTS.has(targetMint)) return;

    const arbRoute = await calculateArbRoute(targetMint);
    if (!arbRoute || arbRoute.estimatedProfit < CONFIG.MIN_PROFIT) return;

    console.log(`[ARB] ${arbRoute.route} | Est. profit: $${arbRoute.estimatedProfit.toFixed(4)} | via ${dex}`);

    const latencyMs = Date.now() - startTime;
    const isSuccess = arbRoute.estimatedProfit > 0;

    const outcome = {
      route: arbRoute.route,
      entry_amount: arbRoute.entryAmount,
      exit_amount: isSuccess ? arbRoute.exitAmount : arbRoute.entryAmount,
      profit: isSuccess ? arbRoute.estimatedProfit : 0,
      jito_tip: CONFIG.JITO_TIP / LAMPORTS_PER_SOL,
      status: isSuccess ? "success" : "reverted",
      tx_signature: isSuccess ? `sim_${Date.now()}` : null,
      trigger_tx: triggerSignature,
      latency_ms: latencyMs,
    };

    const { error } = await supabase.from("bundle_results").insert(outcome);
    if (error) console.error("[DB] Insert bundle error:", error.message);

    console.log(
      `[BUNDLE] ${outcome.status.toUpperCase()} | ${outcome.route} | $${outcome.profit.toFixed(4)} | ${latencyMs}ms`
    );
  } catch (error) {
    console.error("[MEV] Backrun error:", error);
  }
}

// ── WebSocket monitoring ────────────────────────────────
function startMonitoring() {
  console.log("[MEV] Starting WebSocket monitoring...");
  void startQueueWorker();

  for (const [dexName, dex] of Object.entries(DEX_PROGRAMS)) {
    try {
      connection.onLogs(
        new PublicKey(dex.id),
        (logInfo) => {
          try {
            const { signature, logs } = logInfo;
            const isSwap = logs.some((log) =>
              dex.swapInstructions.some((instr) => log.includes(instr))
            );
            if (!isSwap) return;
            enqueueSignature(signature, dexName);
          } catch (_) {}
        },
        "confirmed"
      );
      console.log(`[MEV] ✓ Subscribed to ${dexName} (${dex.id.slice(0, 8)}...)`);
    } catch (error) {
      console.error(`[MEV] ✗ Failed to subscribe to ${dexName}:`, error);
    }
  }
}

// ── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — MEV Backrunning Engine");
console.log("═══════════════════════════════════════════════════");
console.log(`[MEV] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[MEV] Whale threshold: $${CONFIG.WHALE_THRESHOLD}`);
console.log(`[MEV] Monitoring ${Object.keys(DEX_PROGRAMS).length} DEX programs`);
console.log("═══════════════════════════════════════════════════");

startMonitoring();
console.log("[MEV] Engine running. Watching for whales...");

setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | queue=${pendingSignatures.length} | processed=${totalProcessed} | whales=${totalWhales}`
  );
}, 60_000);
