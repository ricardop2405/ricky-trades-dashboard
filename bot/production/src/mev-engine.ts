/**
 * RICKY TRADES — Atomic Triangular Arb Engine (Jito Bundles)
 *
 * Monitors whale swaps on 8 Solana DEXes via WebSocket.
 * Finds triangular arb routes: USDC → IntermediateToken → TargetToken → USDC
 * Submits as atomic Jito bundles — profit or full revert, $0 cost on failure.
 *
 * Usage: npm run mev
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import {
  DEX_PROGRAMS,
  USDC_MINT,
  SOL_MINT,
  STABLECOIN_MINTS,
  JITO_TIP_ACCOUNTS,
  ARB_INTERMEDIATE_TOKENS,
} from "./constants";
import { sleep, isRateLimitError, getTokenName } from "./utils";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
// ── MEV config (all fields defined in config.ts) ────────
const {
  HELIUS_WS,
  MAX_PENDING_SIGNATURES,
  RATE_LIMIT_BACKOFF_MS,
  MAX_GET_TX_RETRIES,
  MEV_ENTRY_USDC,
  JITO_TIP,
  MIN_PROFIT,
  WHALE_THRESHOLD,
  PARSED_TX_MIN_INTERVAL_MS,
  JITO_BLOCK_ENGINE_URL,
  MEV_DRY_RUN,
} = CONFIG;

// ── Types ───────────────────────────────────────────────
interface PendingSignature {
  signature: string;
  dex: string;
}

interface ArbRoute {
  intermediateSymbol: string;
  intermediateMint: string;
  targetMint: string;
  targetSymbol: string;
  quotes: any[];
  entryAmount: number;
  exitAmount: number;
  estimatedProfit: number;
  route: string;
}

// ── State ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  wsEndpoint: HELIUS_WS,
  commitment: "confirmed",
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const pendingSignatures: PendingSignature[] = [];
const queuedSignatures = new Set<string>();
let isQueueWorkerRunning = false;
let rpcCooldownUntil = 0;
let totalProcessed = 0;
let totalWhales = 0;
let totalBundlesSent = 0;
let totalProfit = 0;

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

// ── USDC balance check ─────────────────────────────────
async function getUsdcBalance(): Promise<number> {
  try {
    const usdcMint = new PublicKey(USDC_MINT);
    const ata = getAssociatedTokenAddressSync(usdcMint, keypair.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.amount || 0);
  } catch {
    return 0;
  }
}

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

  const wallet =
    tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || "unknown";
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];

  const changes: { mint: string; diff: number }[] = [];

  for (const post of postBalances) {
    const pre = preBalances.find(
      (p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint
    );
    const preAmt = Number(pre?.uiTokenAmount?.uiAmount || 0);
    const postAmt = Number(post.uiTokenAmount?.uiAmount || 0);
    const diff = postAmt - preAmt;
    if (Math.abs(diff) > 0.000001) {
      changes.push({ mint: post.mint, diff });
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

  const direction: "buy" | "sell" = STABLECOIN_MINTS.has(tokenInMint)
    ? "buy"
    : "sell";

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

// ── Jupiter quote helper ────────────────────────────────
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 50
): Promise<any | null> {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch {
    return null;
  }
}

// ── Jupiter swap transaction helper ─────────────────────
async function getJupiterSwapTx(quote: any): Promise<Buffer | null> {
  try {
    const res = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 0, // Jito tip handles priority
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Buffer.from(data.swapTransaction, "base64");
  } catch {
    return null;
  }
}

// ── Multi-route arb scanner ─────────────────────────────
async function findBestArbRoute(
  targetMint: string
): Promise<ArbRoute | null> {
  const entryAmount = CONFIG.MEV_ENTRY_USDC; // raw USDC (6 decimals)
  const results: ArbRoute[] = [];

  // Try direct: USDC → Target → USDC (2-leg, checking if mispriced)
  // Try triangular: USDC → Intermediate → Target → USDC (3-leg)
  const candidates = ARB_INTERMEDIATE_TOKENS.filter(
    (t) => t.mint !== targetMint
  );

  const quotePromises = candidates.map(async (intermediate) => {
    try {
      // Leg 1: USDC → Intermediate
      const q1 = await getJupiterQuote(USDC_MINT, intermediate.mint, entryAmount);
      if (!q1) return null;

      // Leg 2: Intermediate → Target
      const q2 = await getJupiterQuote(
        intermediate.mint,
        targetMint,
        Number(q1.outAmount)
      );
      if (!q2) return null;

      // Leg 3: Target → USDC
      const q3 = await getJupiterQuote(targetMint, USDC_MINT, Number(q2.outAmount));
      if (!q3) return null;

      const exitAmount = Number(q3.outAmount);
      const tipUSD = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
      const profitRaw = exitAmount - entryAmount;
      const profitUSD = profitRaw / 1_000_000 - tipUSD;

      if (profitUSD <= 0) return null;

      return {
        intermediateSymbol: intermediate.symbol,
        intermediateMint: intermediate.mint,
        targetMint,
        targetSymbol: getTokenName(targetMint),
        quotes: [q1, q2, q3],
        entryAmount: entryAmount / 1_000_000,
        exitAmount: exitAmount / 1_000_000,
        estimatedProfit: profitUSD,
        route: `USDC → ${intermediate.symbol} → ${getTokenName(targetMint)} → USDC`,
      } as ArbRoute;
    } catch {
      return null;
    }
  });

  const settled = await Promise.all(quotePromises);
  for (const r of settled) {
    if (r) results.push(r);
  }

  if (results.length === 0) return null;

  // Pick the most profitable route
  results.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
  return results[0];
}

// ── Build & submit Jito atomic bundle ───────────────────
async function submitJitoBundle(arbRoute: ArbRoute): Promise<{
  success: boolean;
  bundleId?: string;
  error?: string;
}> {
  try {
    // Get serialized swap transactions for all 3 legs
    const [swapTx1Buf, swapTx2Buf, swapTx3Buf] = await Promise.all([
      getJupiterSwapTx(arbRoute.quotes[0]),
      getJupiterSwapTx(arbRoute.quotes[1]),
      getJupiterSwapTx(arbRoute.quotes[2]),
    ]);

    if (!swapTx1Buf || !swapTx2Buf || !swapTx3Buf) {
      return { success: false, error: "Failed to get swap transactions from Jupiter" };
    }

    // Deserialize each swap tx
    const tx1 = VersionedTransaction.deserialize(swapTx1Buf);
    const tx2 = VersionedTransaction.deserialize(swapTx2Buf);
    const tx3 = VersionedTransaction.deserialize(swapTx3Buf);

    // Build Jito tip instruction
    const tipAccount =
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: CONFIG.JITO_TIP,
    });

    // Create a tip transaction
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipMsg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();
    const tipTx = new VersionedTransaction(tipMsg);

    // Sign all transactions
    tx1.sign([keypair]);
    tx2.sign([keypair]);
    tx3.sign([keypair]);
    tipTx.sign([keypair]);

    // Encode as base58 for Jito bundle API
    const encodedTxs = [tx1, tx2, tx3, tipTx].map((tx) =>
      bs58.encode(tx.serialize())
    );

    // Submit bundle to Jito Block Engine
    const bundleRes = await fetch(
      `${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [encodedTxs],
        }),
      }
    );

    const bundleData = await bundleRes.json();

    if (bundleData.error) {
      return { success: false, error: bundleData.error.message || JSON.stringify(bundleData.error) };
    }

    const bundleId = bundleData.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    // Poll for bundle status (up to 30s)
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const statusRes = await fetch(
          `${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getBundleStatuses",
              params: [[bundleId]],
            }),
          }
        );
        const statusData = await statusRes.json();
        const statuses = statusData?.result?.value;
        if (statuses && statuses.length > 0) {
          const status = statuses[0];
          if (status.confirmation_status === "confirmed" || status.confirmation_status === "finalized") {
            return { success: true, bundleId };
          }
          if (status.err) {
            return { success: false, bundleId, error: "Bundle reverted (profit guard triggered — $0 cost)" };
          }
        }
      } catch {
        // continue polling
      }
    }

    return { success: false, bundleId, error: "Bundle status unknown after 30s" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Execute atomic backrun ──────────────────────────────
async function executeBackrun(
  swapInfo: any,
  triggerSignature: string,
  dex: string
) {
  const startTime = Date.now();

  try {
    const targetMint = swapInfo.tokenOutMint || SOL_MINT;
    if (STABLECOIN_MINTS.has(targetMint)) return;

    // Check USDC balance
    const balance = await getUsdcBalance();
    if (balance < CONFIG.MEV_ENTRY_USDC) {
      console.warn(
        `[MEV] Insufficient USDC: ${balance / 1e6} < ${CONFIG.MEV_ENTRY_USDC / 1e6}`
      );
      return;
    }

    // Find best triangular arb route across all intermediate tokens
    const arbRoute = await findBestArbRoute(targetMint);
    if (!arbRoute || arbRoute.estimatedProfit < CONFIG.MIN_PROFIT) return;

    console.log(
      `[ARB] ${arbRoute.route} | Est. profit: $${arbRoute.estimatedProfit.toFixed(4)} | via ${dex}`
    );

    const latencyMs = Date.now() - startTime;

    // DRY RUN: log but don't submit
    if (CONFIG.MEV_DRY_RUN) {
      console.log(
        `[DRY-RUN] Would submit bundle: ${arbRoute.route} | $${arbRoute.estimatedProfit.toFixed(4)} profit`
      );

      await supabase.from("bundle_results").insert({
        route: arbRoute.route,
        entry_amount: arbRoute.entryAmount,
        exit_amount: arbRoute.exitAmount,
        profit: arbRoute.estimatedProfit,
        jito_tip: CONFIG.JITO_TIP / LAMPORTS_PER_SOL,
        status: "dry_run",
        tx_signature: null,
        trigger_tx: triggerSignature,
        latency_ms: latencyMs,
      });
      return;
    }

    // LIVE: submit atomic Jito bundle
    totalBundlesSent++;
    const result = await submitJitoBundle(arbRoute);

    const outcome = {
      route: arbRoute.route,
      entry_amount: arbRoute.entryAmount,
      exit_amount: result.success ? arbRoute.exitAmount : arbRoute.entryAmount,
      profit: result.success ? arbRoute.estimatedProfit : 0,
      jito_tip: CONFIG.JITO_TIP / LAMPORTS_PER_SOL,
      status: result.success ? "success" : "reverted",
      tx_signature: result.bundleId || null,
      trigger_tx: triggerSignature,
      latency_ms: Date.now() - startTime,
    };

    if (result.success) {
      totalProfit += arbRoute.estimatedProfit;
    }

    const { error } = await supabase.from("bundle_results").insert(outcome);
    if (error) console.error("[DB] Insert bundle error:", error.message);

    console.log(
      `[BUNDLE] ${outcome.status.toUpperCase()} | ${outcome.route} | $${outcome.profit.toFixed(4)} | ${outcome.latency_ms}ms${
        result.error ? ` | ${result.error}` : ""
      }`
    );
  } catch (error) {
    console.error("[MEV] Backrun error:", error);
  }
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

    // Log whale trade
    const { error } = await supabase.from("whale_trades").insert({
      wallet: swapInfo.wallet,
      token_in: swapInfo.tokenIn,
      token_out: swapInfo.tokenOut,
      amount_usd: swapInfo.amountUSD,
      tx_signature: signature,
      direction: swapInfo.direction,
    });
    if (error) console.error("[DB] Insert whale_trade error:", error.message);

    // Attempt atomic arb on any whale swap
    await executeBackrun(swapInfo, signature, dex);
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
      console.log(
        `[MEV] ✓ Subscribed to ${dexName} (${dex.id.slice(0, 8)}...)`
      );
    } catch (error) {
      console.error(`[MEV] ✗ Failed to subscribe to ${dexName}:`, error);
    }
  }
}

// ── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Atomic Triangular Arb Engine");
console.log("═══════════════════════════════════════════════════");
console.log(`[MEV] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[MEV] Entry size: $${CONFIG.MEV_ENTRY_USDC / 1e6} USDC`);
console.log(`[MEV] Whale threshold: $${CONFIG.WHALE_THRESHOLD}`);
console.log(`[MEV] Min profit: $${CONFIG.MIN_PROFIT}`);
console.log(`[MEV] Jito tip: ${CONFIG.JITO_TIP} lamports`);
console.log(`[MEV] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log(`[MEV] Intermediate tokens: ${ARB_INTERMEDIATE_TOKENS.map((t) => t.symbol).join(", ")}`);
console.log(`[MEV] Monitoring ${Object.keys(DEX_PROGRAMS).length} DEX programs`);
console.log("═══════════════════════════════════════════════════");

startMonitoring();
console.log("[MEV] Engine running. Watching for whales...");

setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | queue=${pendingSignatures.length} | processed=${totalProcessed} | whales=${totalWhales} | bundles=${totalBundlesSent} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);
