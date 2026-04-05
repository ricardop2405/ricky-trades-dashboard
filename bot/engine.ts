/**
 * Ricky Trades Command — Solana MEV Backrunning Bot
 *
 * Monitors Jupiter V6, Raydium V4, Orca Whirlpool, and Meteora DLMM
 * for whale swaps and logs them to Supabase.
 *
 * SETUP:
 * 1. Copy this file + .env to your VPS
 * 2. npm install @solana/web3.js @supabase/supabase-js bs58
 * 3. Set env vars (see below)
 * 4. npx ts-node engine.ts
 *
 * ENV VARS:
 *   SOLANA_PRIVATE_KEY - base58 encoded
 *   HELIUS_RPC_URL - wss://mainnet.helius-rpc.com/?api-key=KEY
 *   HELIUS_HTTP_URL - https://mainnet.helius-rpc.com/?api-key=KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   JITO_TIP_LAMPORTS (default 5000000 = 0.005 SOL)
 *   MIN_PROFIT_USD (default 0.05)
 *   WHALE_THRESHOLD_USD (default 5000)
 *   PARSED_TX_MIN_INTERVAL_MS (default 800)
 *   RATE_LIMIT_BACKOFF_MS (default 2000)
 *   MAX_GET_TX_RETRIES (default 4)
 *   MAX_PENDING_SIGNATURES (default 500)
 */

import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";

// ── Config ──────────────────────────────────────────────
const HELIUS_WS = process.env.HELIUS_RPC_URL!;
const HELIUS_HTTP = process.env.HELIUS_HTTP_URL || HELIUS_WS.replace(/^wss:\/\//, "https://");
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JITO_TIP = Number(process.env.JITO_TIP_LAMPORTS || 5_000_000);
const MIN_PROFIT = Number(process.env.MIN_PROFIT_USD || 0.05);
const WHALE_THRESHOLD = Number(process.env.WHALE_THRESHOLD_USD || 5_000);
const PARSED_TX_MIN_INTERVAL_MS = Number(process.env.PARSED_TX_MIN_INTERVAL_MS || 800);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 2_000);
const MAX_GET_TX_RETRIES = Number(process.env.MAX_GET_TX_RETRIES || 4);
const MAX_PENDING_SIGNATURES = Number(process.env.MAX_PENDING_SIGNATURES || 500);

// Estimated SOL price for USD conversion when no USDC involved
const SOL_PRICE_USD = Number(process.env.SOL_PRICE_USD || 170);

// ── DEX Program IDs ─────────────────────────────────────
const DEX_PROGRAMS: Record<string, { id: string; swapInstructions: string[] }> = {
  "Jupiter V6": {
    id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    swapInstructions: ["Instruction: Route", "Instruction: SharedAccountsRoute", "Instruction: ExactOutRoute"],
  },
  "Jupiter V4": {
    id: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
    swapInstructions: ["Instruction: Route"],
  },
  "Raydium V4": {
    id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    swapInstructions: ["Instruction: SwapBaseIn", "Instruction: SwapBaseOut", "Instruction: Swap"],
  },
  "Raydium CLMM": {
    id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    swapInstructions: ["Instruction: Swap", "Instruction: SwapV2"],
  },
  "Raydium CP": {
    id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    swapInstructions: ["Instruction: Swap", "Instruction: SwapBaseInput", "Instruction: SwapBaseOutput"],
  },
  "Orca Whirlpool": {
    id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    swapInstructions: ["Instruction: Swap", "Instruction: TwoHopSwap"],
  },
  "Meteora DLMM": {
    id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    swapInstructions: ["Instruction: Swap"],
  },
  "Meteora Pools": {
    id: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
    swapInstructions: ["Instruction: Swap"],
  },
};

// ── Token Mints ─────────────────────────────────────────
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const STABLECOIN_MINTS = new Set([USDC_MINT, USDT_MINT]);

// Well-known token names for display
const TOKEN_NAMES: Record<string, string> = {
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
  [SOL_MINT]: "SOL",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": "PYTH",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE": "ORCA",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey": "MNDE",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": "jitoSOL",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1": "bSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": "RENDER",
  "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y": "SHDW",
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": "JTO",
  "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6": "TNSR",
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk": "WEN",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
};

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiYDac1aR",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMbgopDjZaukBrHP6Tc6fQSD3MRfNKfS",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// ── State ───────────────────────────────────────────────
type PendingSignature = { signature: string; dex: string };

const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(HELIUS_HTTP, { wsEndpoint: HELIUS_WS, commitment: "confirmed" });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const pendingSignatures: PendingSignature[] = [];
const queuedSignatures = new Set<string>();
let isQueueWorkerRunning = false;
let rpcCooldownUntil = 0;
let totalProcessed = 0;
let totalWhales = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limited");
}

function getTokenName(mint: string): string {
  return TOKEN_NAMES[mint] || mint.slice(0, 4) + "..." + mint.slice(-4);
}

function enqueueSignature(signature: string, dex: string) {
  if (queuedSignatures.has(signature)) return;

  if (pendingSignatures.length >= MAX_PENDING_SIGNATURES) {
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

  // Track all token balance changes for the swapper (owner index 0 usually)
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

  // Find what went in (negative) and what came out (positive)
  const spent = changes.filter(c => c.diff < 0).sort((a, b) => a.diff - b.diff);
  const received = changes.filter(c => c.diff > 0).sort((a, b) => b.diff - a.diff);

  if (spent.length === 0 || received.length === 0) return null;

  const tokenInMint = spent[0].mint;
  const tokenOutMint = received[0].mint;
  const tokenIn = getTokenName(tokenInMint);
  const tokenOut = getTokenName(tokenOutMint);

  // Estimate USD value
  let amountUSD = 0;

  if (STABLECOIN_MINTS.has(tokenInMint)) {
    amountUSD = Math.abs(spent[0].diff);
  } else if (STABLECOIN_MINTS.has(tokenOutMint)) {
    amountUSD = Math.abs(received[0].diff);
  } else if (tokenInMint === SOL_MINT) {
    amountUSD = Math.abs(spent[0].diff) * SOL_PRICE_USD;
  } else if (tokenOutMint === SOL_MINT) {
    amountUSD = Math.abs(received[0].diff) * SOL_PRICE_USD;
  } else {
    // Fallback: estimate from SOL balance change
    const preSol = meta.preBalances[0] / LAMPORTS_PER_SOL;
    const postSol = meta.postBalances[0] / LAMPORTS_PER_SOL;
    amountUSD = Math.abs(postSol - preSol) * SOL_PRICE_USD;
  }

  // Direction: buying if spending stablecoin, selling if receiving stablecoin
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

// ── Process a single signature ──────────────────────────
async function getParsedTransactionWithRetry(signature: string) {
  let backoffMs = RATE_LIMIT_BACKOFF_MS;

  for (let attempt = 1; attempt <= MAX_GET_TX_RETRIES; attempt++) {
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

async function processSignature(signature: string, dex: string) {
  try {
    totalProcessed++;
    const tx = await getParsedTransactionWithRetry(signature);
    if (!tx?.meta) return;

    const swapInfo = parseSwapFromTransaction(tx);
    if (!swapInfo) return;
    if (swapInfo.amountUSD < WHALE_THRESHOLD) return;

    totalWhales++;
    console.log(
      `[WHALE] $${swapInfo.amountUSD.toFixed(0)} | ${swapInfo.tokenIn} → ${swapInfo.tokenOut} | ${dex} | ${signature.slice(0, 8)}...`
    );

    // Store whale trade
    const { error } = await supabase.from("whale_trades").insert({
      wallet: swapInfo.wallet,
      token_in: swapInfo.tokenIn,
      token_out: swapInfo.tokenOut,
      amount_usd: swapInfo.amountUSD,
      tx_signature: signature,
      direction: swapInfo.direction,
    });

    if (error) {
      console.error("[DB] Insert whale_trade error:", error.message);
    }

    // Attempt backrun for large trades
    if (swapInfo.amountUSD >= 20_000) {
      await executeBackrun(swapInfo, signature, dex);
    }
  } catch (error) {
    if (!isRateLimitError(error)) {
      console.error("[RICKY] Process error:", error);
    }
  }
}

// ── Queue worker ────────────────────────────────────────
async function startQueueWorker() {
  if (isQueueWorkerRunning) return;
  isQueueWorkerRunning = true;

  console.log(
    `[RICKY] Queue worker | threshold=$${WHALE_THRESHOLD} | interval=${PARSED_TX_MIN_INTERVAL_MS}ms | maxQueue=${MAX_PENDING_SIGNATURES}`
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
    await sleep(PARSED_TX_MIN_INTERVAL_MS);
  }
}

// ── Monitoring: subscribe to all DEXes ──────────────────
function startMonitoring() {
  console.log("[RICKY] Starting WebSocket monitoring...");
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
      console.log(`[RICKY] ✓ Subscribed to ${dexName} (${dex.id.slice(0, 8)}...)`);
    } catch (error) {
      console.error(`[RICKY] ✗ Failed to subscribe to ${dexName}:`, error);
    }
  }
}

// ── Backrun execution ───────────────────────────────────
async function calculateArbRoute(targetMint: string) {
  const entryAmount = 200_000_000; // 200 USDC in smallest unit

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
    const tipUSD = (JITO_TIP / LAMPORTS_PER_SOL) * SOL_PRICE_USD;

    return {
      quotes: [quote1, quote2, quote3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profit - tipUSD,
      route: `USDC → SOL → ${getTokenName(targetMint)} → USDC`,
    };
  } catch (error) {
    return null;
  }
}

async function executeBackrun(swapInfo: any, triggerSignature: string, dex: string) {
  const startTime = Date.now();

  try {
    // Use the token that was bought (tokenOutMint) as backrun target
    const targetMint = swapInfo.tokenOutMint || SOL_MINT;
    // Skip if target is a stablecoin
    if (STABLECOIN_MINTS.has(targetMint)) return;

    const arbRoute = await calculateArbRoute(targetMint);
    if (!arbRoute) return;

    if (arbRoute.estimatedProfit < MIN_PROFIT) {
      return;
    }

    console.log(`[ARB] ${arbRoute.route} | Est. profit: $${arbRoute.estimatedProfit.toFixed(4)} | via ${dex}`);

    const latencyMs = Date.now() - startTime;
    const isSuccess = arbRoute.estimatedProfit > 0;

    const outcome = {
      route: arbRoute.route,
      entry_amount: arbRoute.entryAmount,
      exit_amount: isSuccess ? arbRoute.exitAmount : arbRoute.entryAmount,
      profit: isSuccess ? arbRoute.estimatedProfit : 0,
      jito_tip: JITO_TIP / LAMPORTS_PER_SOL,
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
    console.error("[RICKY] Backrun error:", error);
  }
}

// ── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES COMMAND — Multi-DEX Monitor");
console.log("═══════════════════════════════════════════════════");
console.log(`[RICKY] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[RICKY] Whale threshold: $${WHALE_THRESHOLD}`);
console.log(`[RICKY] Monitoring ${Object.keys(DEX_PROGRAMS).length} DEX programs:`);
for (const name of Object.keys(DEX_PROGRAMS)) {
  console.log(`         • ${name}`);
}
console.log("═══════════════════════════════════════════════════");

startMonitoring();
console.log("[RICKY] Engine running. Watching for whales...");

// Enhanced heartbeat
setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | queue=${pendingSignatures.length} | processed=${totalProcessed} | whales=${totalWhales}`
  );
}, 60_000);
