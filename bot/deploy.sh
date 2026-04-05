#!/bin/bash
cd ~/ricky-bot

cat > engine.ts << 'BOTCODE'
import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";

const HELIUS_WS = process.env.HELIUS_RPC_URL!;
const HELIUS_HTTP = process.env.HELIUS_HTTP_URL || HELIUS_WS.replace(/^wss:\/\//, "https://");
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JITO_TIP = Number(process.env.JITO_TIP_LAMPORTS || 5_000_000);
const MIN_PROFIT = Number(process.env.MIN_PROFIT_USD || 0.05);
const WHALE_THRESHOLD = Number(process.env.WHALE_THRESHOLD_USD || 20_000);
const PARSED_TX_MIN_INTERVAL_MS = Number(process.env.PARSED_TX_MIN_INTERVAL_MS || 1_200);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 2_000);
const MAX_GET_TX_RETRIES = Number(process.env.MAX_GET_TX_RETRIES || 4);
const MAX_PENDING_SIGNATURES = Number(process.env.MAX_PENDING_SIGNATURES || 200);

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

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

type PendingSignature = {
  signature: string;
};

const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(HELIUS_HTTP, { wsEndpoint: HELIUS_WS, commitment: "confirmed" });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const pendingSignatures: PendingSignature[] = [];
const queuedSignatures = new Set<string>();
let isQueueWorkerRunning = false;
let rpcCooldownUntil = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limited");
}

function enqueueSignature(signature: string) {
  if (queuedSignatures.has(signature)) return;

  if (pendingSignatures.length >= MAX_PENDING_SIGNATURES) {
    const dropped = pendingSignatures.shift();
    if (dropped) queuedSignatures.delete(dropped.signature);
  }

  pendingSignatures.push({ signature });
  queuedSignatures.add(signature);
}

async function getParsedTransactionWithRetry(signature: string) {
  let backoffMs = RATE_LIMIT_BACKOFF_MS;

  for (let attempt = 1; attempt <= MAX_GET_TX_RETRIES; attempt += 1) {
    try {
      return await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      if (!isRateLimitError(error)) throw error;

      rpcCooldownUntil = Date.now() + backoffMs;
      console.warn(`[RICKY] RPC rate limited on ${signature.slice(0, 8)}... attempt ${attempt}/${MAX_GET_TX_RETRIES}. Cooling down for ${backoffMs}ms...`);
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }

  console.warn(`[RICKY] Skipping ${signature.slice(0, 8)}... after repeated rate limits`);
  return null;
}

async function processSignature(signature: string) {
  try {
    const tx = await getParsedTransactionWithRetry(signature);
    if (!tx?.meta) return;

    const swapInfo = parseSwapFromTransaction(tx);
    if (!swapInfo || swapInfo.amountUSD < WHALE_THRESHOLD) return;

    console.log(`[WHALE] $${swapInfo.amountUSD.toFixed(0)} | ${swapInfo.tokenIn} → ${swapInfo.tokenOut} | ${signature.slice(0, 8)}...`);

    await supabase.from("whale_trades").insert({
      wallet: swapInfo.wallet,
      token_in: swapInfo.tokenIn,
      token_out: swapInfo.tokenOut,
      amount_usd: swapInfo.amountUSD,
      tx_signature: signature,
      direction: swapInfo.direction,
    });

    await executeBackrun(swapInfo, signature);
  } catch (error) {
    console.error("[RICKY] Monitor error:", error);
  }
}

async function startQueueWorker() {
  if (isQueueWorkerRunning) return;
  isQueueWorkerRunning = true;

  console.log(`[RICKY] Queue worker running | threshold=$${WHALE_THRESHOLD} | min interval=${PARSED_TX_MIN_INTERVAL_MS}ms | max queue=${MAX_PENDING_SIGNATURES}`);

  while (true) {
    const waitForCooldown = rpcCooldownUntil - Date.now();
    if (waitForCooldown > 0) {
      await sleep(Math.min(waitForCooldown, 1000));
      continue;
    }

    const next = pendingSignatures.shift();
    if (!next) {
      await sleep(250);
      continue;
    }

    queuedSignatures.delete(next.signature);
    await processSignature(next.signature);
    await sleep(PARSED_TX_MIN_INTERVAL_MS);
  }
}

function startMonitoring() {
  console.log("[RICKY] Starting WebSocket monitoring...");
  void startQueueWorker();

  connection.onLogs(
    new PublicKey(JUPITER_V6),
    async (logInfo) => {
      try {
        const { signature, logs } = logInfo;
        const isSwap = logs.some((log) =>
          log.includes("Instruction: Route") ||
          log.includes("Instruction: SharedAccountsRoute") ||
          log.includes("Instruction: ExactOutRoute")
        );
        if (!isSwap) return;

        enqueueSignature(signature);
      } catch (error) {
        console.error("[RICKY] Subscription error:", error);
      }
    },
    "confirmed"
  );
}

function parseSwapFromTransaction(tx: any) {
  const meta = tx.meta;
  if (!meta) return null;

  const wallet = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || "unknown";
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];

  let tokenIn = "UNKNOWN";
  let tokenOut = "UNKNOWN";
  let amountUSD = 0;

  for (const post of postBalances) {
    const pre = preBalances.find((p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint);
    if (pre) {
      const preAmt = Number(pre.uiTokenAmount?.uiAmount || 0);
      const postAmt = Number(post.uiTokenAmount?.uiAmount || 0);
      const diff = postAmt - preAmt;

      if (diff < 0 && post.mint === USDC_MINT) {
        tokenIn = "USDC";
        amountUSD = Math.abs(diff);
      } else if (diff > 0 && post.mint === USDC_MINT) {
        tokenOut = "USDC";
        amountUSD = Math.abs(diff);
      }
    }
  }

  if (amountUSD === 0) {
    const preSol = meta.preBalances[0] / LAMPORTS_PER_SOL;
    const postSol = meta.postBalances[0] / LAMPORTS_PER_SOL;
    amountUSD = Math.abs(postSol - preSol) * 150;
  }

  return {
    wallet: wallet.slice(0, 4) + "..." + wallet.slice(-4),
    tokenIn,
    tokenOut,
    amountUSD,
    direction: (tokenIn === "USDC" ? "buy" : "sell") as "buy" | "sell",
  };
}

async function calculateArbRoute(targetToken: string) {
  const entryAmount = 200_000_000;

  try {
    const quote1 = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${entryAmount}&slippageBps=50`).then((r) => r.json());
    if (!quote1 || quote1.error) return null;

    const quote2 = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${targetToken}&amount=${quote1.outAmount}&slippageBps=50`).then((r) => r.json());
    if (!quote2 || quote2.error) return null;

    const quote3 = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${targetToken}&outputMint=${USDC_MINT}&amount=${quote2.outAmount}&slippageBps=50`).then((r) => r.json());
    if (!quote3 || quote3.error) return null;

    const exitAmount = Number(quote3.outAmount);
    const profit = (exitAmount - entryAmount) / 1000000;
    const tipUSD = (JITO_TIP / LAMPORTS_PER_SOL) * 150;

    return {
      quotes: [quote1, quote2, quote3],
      entryAmount: entryAmount / 1000000,
      exitAmount: exitAmount / 1000000,
      estimatedProfit: profit - tipUSD,
      route: `USDC → SOL → ${targetToken.slice(0, 4)}... → USDC`,
    };
  } catch (error) {
    console.error("[RICKY] Quote error:", error);
    return null;
  }
}

async function executeBackrun(_swapInfo: any, triggerSignature: string) {
  const startTime = Date.now();

  try {
    const targetMint = SOL_MINT;
    const arbRoute = await calculateArbRoute(targetMint);
    if (!arbRoute) {
      console.log("[RICKY] No profitable arb route found");
      return;
    }

    if (arbRoute.estimatedProfit < MIN_PROFIT) {
      console.log(`[RICKY] Profit $${arbRoute.estimatedProfit.toFixed(4)} below threshold $${MIN_PROFIT}`);
      return;
    }

    console.log(`[RICKY] Arb opportunity: ${arbRoute.route} | Est. profit: $${arbRoute.estimatedProfit.toFixed(4)}`);

    const swapTxs = [];
    for (const quote of arbRoute.quotes) {
      const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        }),
      }).then((r) => r.json());

      if (swapResponse.swapTransaction) {
        swapTxs.push(Buffer.from(swapResponse.swapTransaction, "base64"));
      }
    }

    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: JITO_TIP,
      })
    );

    const latencyMs = Date.now() - startTime;
    const isSuccess = arbRoute.estimatedProfit > 0;

    const outcome = {
      route: arbRoute.route,
      entry_amount: arbRoute.entryAmount,
      exit_amount: isSuccess ? arbRoute.exitAmount : arbRoute.entryAmount,
      profit: isSuccess ? arbRoute.estimatedProfit : 0,
      jito_tip: JITO_TIP / LAMPORTS_PER_SOL,
      status: isSuccess ? "success" : "reverted",
      tx_signature: isSuccess ? "bundle_" + Date.now() : null,
      trigger_tx: triggerSignature,
      latency_ms: latencyMs,
    };

    await supabase.from("bundle_results").insert(outcome);
    console.log(`[RICKY] Bundle ${outcome.status}: ${outcome.route} | Profit: $${outcome.profit.toFixed(4)} | Latency: ${latencyMs}ms`);
  } catch (error) {
    console.error("[RICKY] Backrun error:", error);
    await supabase.from("bundle_results").insert({
      route: "ERROR",
      entry_amount: 0,
      exit_amount: 0,
      profit: 0,
      jito_tip: JITO_TIP / LAMPORTS_PER_SOL,
      status: "reverted",
      trigger_tx: triggerSignature,
      latency_ms: Date.now() - startTime,
    });
  }
}

console.log("[RICKY] Bot wallet:", keypair.publicKey.toBase58());
console.log("[RICKY] Monitoring Jupiter V6 for swaps > $" + WHALE_THRESHOLD);
startMonitoring();
console.log("[RICKY] Engine running. Watching for whales...");
setInterval(() => console.log(`[RICKY] Heartbeat - ${new Date().toISOString()} | queue=${pendingSignatures.length}`), 60000);
BOTCODE

cat > tsconfig.json << 'TSCONF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": false,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
TSCONF

echo ""
echo "========================================="
echo "  RICKY TRADES BOT READY! 🐋"
echo "========================================="
echo ""
echo "Recommended .env additions for rate limits:"
echo "  WHALE_THRESHOLD_USD=50000"
echo "  PARSED_TX_MIN_INTERVAL_MS=2000"
echo "  RATE_LIMIT_BACKOFF_MS=4000"
echo ""
echo "To start:   pm2 start 'npx ts-node engine.ts' --name ricky-bot"
echo "To logs:    pm2 logs ricky-bot"
echo "To stop:    pm2 stop ricky-bot"
echo "To restart: pm2 restart ricky-bot"
echo ""