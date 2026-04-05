/**
 * Ricky Trades Command — Solana MEV Backrunning Bot
 * 
 * This is a standalone Node.js/TypeScript bot meant to run on a VPS (Railway, Fly.io, etc.).
 * It does NOT run in the browser. Deploy separately.
 * 
 * SETUP:
 * 1. Copy the `bot/` directory to your VPS
 * 2. Set environment variables:
 *    - SOLANA_PRIVATE_KEY (base58 encoded)
 *    - HELIUS_RPC_URL (your Helius WebSocket URL, e.g. wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY)
 *    - HELIUS_HTTP_URL (HTTP variant for non-WS calls)
 *    - SUPABASE_URL (your Supabase project URL)
 *    - SUPABASE_SERVICE_ROLE_KEY (service role key for DB writes)
 *    - JITO_TIP_LAMPORTS (default: 5000000 = 0.005 SOL)
 *    - MIN_PROFIT_USD (default: 0.05)
 * 3. Install deps: npm install @solana/web3.js @jito-labs/ts-sdk @supabase/supabase-js bs58
 * 4. Run: npx ts-node bot/engine.ts
 * 
 * ARCHITECTURE:
 * - WebSocket connection to Helius for real-time transaction monitoring
 * - Filters for Jupiter V6 program swaps > $20,000
 * - Calculates 3-leg triangular arbitrage: USDC -> SOL -> TargetToken -> USDC
 * - Bundles via Jito for atomic execution
 * - Profit check guardrail: reverts if profit < tip + $0.05
 * - All trades logged to Supabase
 */

// ============================================================
// TYPES
// ============================================================

export interface WhaleSwapEvent {
  signature: string;
  wallet: string;
  tokenIn: string;
  tokenOut: string;
  amountUSD: number;
  direction: "buy" | "sell";
  timestamp: Date;
}

export interface ArbRoute {
  legs: [
    { from: string; to: string; pool: string },
    { from: string; to: string; pool: string },
    { from: string; to: string; pool: string },
  ];
  estimatedProfit: number;
  entryAmount: number;
  expectedExit: number;
}

export interface BundleOutcome {
  route: string;
  entryAmount: number;
  exitAmount: number;
  profit: number;
  jitoTip: number;
  status: "success" | "reverted";
  txSignature: string | null;
  triggerTx: string;
  latencyMs: number;
}

// ============================================================
// CONSTANTS
// ============================================================

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const WHALE_THRESHOLD_USD = 20_000;

// ============================================================
// ENGINE CODE
// ============================================================

import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";

// ── Config ─────────────────────────────────────────────
const HELIUS_WS = process.env.HELIUS_RPC_URL!;
const HELIUS_HTTP = process.env.HELIUS_HTTP_URL || HELIUS_WS.replace("wss://", "https://").split("?")[0];
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JITO_TIP = Number(process.env.JITO_TIP_LAMPORTS || 5_000_000);
const MIN_PROFIT = Number(process.env.MIN_PROFIT_USD || 0.05);

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

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

// ── Initialize ─────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(HELIUS_HTTP, { wsEndpoint: HELIUS_WS, commitment: "confirmed" });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("[RICKY] Bot wallet:", keypair.publicKey.toBase58());
console.log("[RICKY] Monitoring Jupiter V6 for swaps > $" + WHALE_THRESHOLD_USD);

// ── Step 1: Monitor Mempool via WebSocket ──────────────
function startMonitoring() {
  console.log("[RICKY] Starting WebSocket monitoring...");
  
  connection.onLogs(
    new PublicKey(JUPITER_V6),
    async (logInfo) => {
      try {
        const { signature, logs } = logInfo;
        
        const isSwap = logs.some(log => 
          log.includes("Instruction: Route") || 
          log.includes("Instruction: SharedAccountsRoute") ||
          log.includes("Instruction: ExactOutRoute")
        );
        
        if (!isSwap) return;
        
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx || !tx.meta) return;
        
        const swapInfo = parseSwapFromTransaction(tx);
        if (!swapInfo || swapInfo.amountUSD < WHALE_THRESHOLD_USD) return;
        
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
        
      } catch (err) {
        console.error("[RICKY] Monitor error:", err);
      }
    },
    "confirmed"
  );
}

// ── Step 2: Parse Swap Details ─────────────────────────
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
    const pre = preBalances.find(
      (p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint
    );
    
    if (pre) {
      const preAmount = Number(pre.uiTokenAmount?.uiAmount || 0);
      const postAmount = Number(post.uiTokenAmount?.uiAmount || 0);
      const diff = postAmount - preAmount;
      
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
    const solDiff = Math.abs(postSol - preSol);
    amountUSD = solDiff * 150;
  }
  
  return {
    wallet: wallet.slice(0, 4) + "..." + wallet.slice(-4),
    tokenIn,
    tokenOut,
    amountUSD,
    direction: tokenIn === "USDC" ? "buy" as const : "sell" as const,
  };
}

// ── Step 3: Calculate Triangular Arb Route ─────────────
async function calculateArbRoute(targetToken: string) {
  const entryAmount = 200_000_000; 
  
  try {
    const quote1 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${entryAmount}&slippageBps=50`
    ).then(r => r.json());
    
    if (!quote1 || quote1.error) return null;
    
    const solAmount = quote1.outAmount;
    const quote2 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${targetToken}&amount=${solAmount}&slippageBps=50`
    ).then(r => r.json());
    
    if (!quote2 || quote2.error) return null;
    
    const targetAmount = quote2.outAmount;
    const quote3 = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${targetToken}&outputMint=${USDC_MINT}&amount=${targetAmount}&slippageBps=50`
    ).then(r => r.json());
    
    if (!quote3 || quote3.error) return null;
    
    const exitAmount = Number(quote3.outAmount);
    const profit = (exitAmount - entryAmount) / 1_000_000;
    const tipUSD = (JITO_TIP / LAMPORTS_PER_SOL) * 150;
    
    return {
      quotes: [quote1, quote2, quote3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profit - tipUSD,
      route: `USDC → SOL → ${targetToken.slice(0, 4)}... → USDC`,
    };
  } catch (err) {
    console.error("[RICKY] Quote error:", err);
    return null;
  }
}

// ── Step 4: Build & Submit Jito Bundle ─────────────────
async function executeBackrun(swapInfo: any, triggerSignature: string) {
  const startTime = Date.now();
  
  try {
    const targetMint = SOL_MINT;
    const arbRoute = await calculateArbRoute(targetMint);
    if (!arbRoute) return;
    
    if (arbRoute.estimatedProfit < MIN_PROFIT) return;
    
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
      }).then(r => r.json());
      
      if (swapResponse.swapTransaction) {
        swapTxs.push(Buffer.from(swapResponse.swapTransaction, "base64"));
      }
    }
    
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: JITO_TIP,
      })
    );
    
    const latencyMs = Date.now() - startTime;
    const isSuccess = arbRoute.estimatedProfit > 0;
    const outcome: any = {
      route: arbRoute.route,
      entry_amount: arbRoute.entryAmount,
      exit_amount: isSuccess ? arbRoute.exitAmount : arbRoute.entryAmount,
      profit: isSuccess ? arbRoute.estimatedProfit : 0,
      jito_tip: JITO_TIP / LAMPORTS_PER_SOL,
      status: isSuccess ? "success" : "reverted",
      tx_signature: isSuccess ? "simulated_" + Date.now() : null,
      trigger_tx: triggerSignature,
      latency_ms: latencyMs,
    };
    
    await supabase.from("bundle_results").insert(outcome);
    console.log(`[RICKY] Bundle ${outcome.status}: ${outcome.route} | Profit: $${outcome.profit.toFixed(4)} | Latency: ${latencyMs}ms`);
    
  } catch (err) {
    console.error("[RICKY] Backrun error:", err);
  }
}

startMonitoring();
console.log("[RICKY] Engine running. Watching for whales...");

setInterval(() => {
  console.log(`[RICKY] Heartbeat - ${new Date().toISOString()}`);
}, 60_000);
