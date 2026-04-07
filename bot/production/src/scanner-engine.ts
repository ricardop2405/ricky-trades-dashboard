/**
 * RICKY TRADES — Continuous Arb Scanner v2
 *
 * Scans ALL token pairs via Jupiter Quote API (free, no RPC needed).
 * Two strategies:
 *   1. 2-leg direct: USDC → Token → USDC (price inefficiency on single token)
 *   2. 3-leg triangular: USDC → TokenA → TokenB → USDC
 *
 * Safety features for memecoins:
 *   - Smaller entry sizes for low-liquidity tokens
 *   - Quote validation (output must be reasonable vs input)
 *   - Slippage guard on execution
 *
 * Usage: npm run scanner
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
  USDC_MINT,
  JITO_TIP_ACCOUNTS,
  ALL_SCAN_TOKENS,
  MEMECOIN_TOKENS,
  ARB_INTERMEDIATE_TOKENS,
  generateScanPairs,
  ENTRY_SIZES_USDC,
} from "./constants";
import { sleep, getTokenName } from "./utils";

// ── State ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const MEMECOIN_MINTS = new Set(MEMECOIN_TOKENS.map((t) => t.mint));

let totalScans = 0;
let total2Leg = 0;
let total3Leg = 0;
let totalOpportunities = 0;
let totalBundlesSent = 0;
let totalProfit = 0;
let usdcBalanceCache = 0;
let lastBalanceCheck = 0;

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function getUsdcBalance(): Promise<number> {
  // Cache balance for 30s to avoid RPC spam
  if (Date.now() - lastBalanceCheck < 30_000 && usdcBalanceCache > 0) {
    return usdcBalanceCache;
  }
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    usdcBalanceCache = Number(balance.value.amount || 0);
    lastBalanceCheck = Date.now();
    return usdcBalanceCache;
  } catch {
    return usdcBalanceCache;
  }
}

// ── Jupiter helpers ─────────────────────────────────────
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 30
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
        prioritizationFeeLamports: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Buffer.from(data.swapTransaction, "base64");
  } catch {
    return null;
  }
}

// ── Safety: determine max entry for a token ─────────────
function getMaxEntry(mint: string): number {
  // Memecoins get smaller entries to avoid slippage traps
  if (MEMECOIN_MINTS.has(mint)) return 25_000_000; // max $25
  return 100_000_000; // $100 for blue chips
}

function isSafeQuote(inputAmount: number, outputAmount: number, isMemecoin: boolean): boolean {
  // Sanity check: output shouldn't be more than 2x input (likely bad quote data)
  // and shouldn't be less than 50% (extreme slippage)
  const ratio = outputAmount / inputAmount;
  if (ratio > 2.0) return false;
  if (isMemecoin && ratio < 0.7) return false; // tighter for memecoins
  if (!isMemecoin && ratio < 0.5) return false;
  return true;
}

// ── Scan result type ────────────────────────────────────
interface ScanResult {
  route: string;
  legs: number;
  quotes: any[];
  entryAmount: number;
  exitAmount: number;
  estimatedProfit: number;
  entryRaw: number;
}

// ── 2-leg direct arb: USDC → Token → USDC ──────────────
async function scan2Leg(
  tokenMint: string,
  tokenSymbol: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    const isMemecoin = MEMECOIN_MINTS.has(tokenMint);
    if (entryAmount > getMaxEntry(tokenMint)) return null;

    // Leg 1: USDC → Token
    const q1 = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, isMemecoin ? 100 : 30);
    if (!q1) return null;

    // Leg 2: Token → USDC
    const q2 = await getJupiterQuote(tokenMint, USDC_MINT, Number(q1.outAmount), isMemecoin ? 100 : 30);
    if (!q2) return null;

    const exitAmount = Number(q2.outAmount);

    // Safety check
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return null;

    const tipUSD = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
    const profitUSD = (exitAmount - entryAmount) / 1_000_000 - tipUSD;

    if (profitUSD <= 0) return null;

    return {
      route: `USDC → ${tokenSymbol} → USDC`,
      legs: 2,
      quotes: [q1, q2],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUSD,
      entryRaw: entryAmount,
    };
  } catch {
    return null;
  }
}

// ── 3-leg triangular: USDC → A → B → USDC ──────────────
async function scan3Leg(
  tokenA: string,
  symbolA: string,
  tokenB: string,
  symbolB: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    const isMemecoinA = MEMECOIN_MINTS.has(tokenA);
    const isMemecoinB = MEMECOIN_MINTS.has(tokenB);
    const hasMemecoin = isMemecoinA || isMemecoinB;

    if (hasMemecoin && entryAmount > 25_000_000) return null; // $25 max for memecoin routes

    const slippage = hasMemecoin ? 100 : 30;

    const q1 = await getJupiterQuote(USDC_MINT, tokenA, entryAmount, slippage);
    if (!q1) return null;

    const q2 = await getJupiterQuote(tokenA, tokenB, Number(q1.outAmount), slippage);
    if (!q2) return null;

    const q3 = await getJupiterQuote(tokenB, USDC_MINT, Number(q2.outAmount), slippage);
    if (!q3) return null;

    const exitAmount = Number(q3.outAmount);

    if (!isSafeQuote(entryAmount, exitAmount, hasMemecoin)) return null;

    const tipUSD = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
    const profitUSD = (exitAmount - entryAmount) / 1_000_000 - tipUSD;

    if (profitUSD <= 0) return null;

    return {
      route: `USDC → ${symbolA} → ${symbolB} → USDC`,
      legs: 3,
      quotes: [q1, q2, q3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUSD,
      entryRaw: entryAmount,
    };
  } catch {
    return null;
  }
}

// ── Submit Jito bundle ──────────────────────────────────
async function submitJitoBundle(result: ScanResult): Promise<{
  success: boolean;
  bundleId?: string;
  error?: string;
}> {
  try {
    const swapBuffers = await Promise.all(
      result.quotes.map((q) => getJupiterSwapTx(q))
    );

    if (swapBuffers.some((b) => !b)) {
      return { success: false, error: "Failed to get swap transactions" };
    }

    const swapTxs = swapBuffers.map((b) => VersionedTransaction.deserialize(b!));

    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: CONFIG.JITO_TIP,
    });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipMsg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();
    const tipTx = new VersionedTransaction(tipMsg);

    for (const tx of swapTxs) tx.sign([keypair]);
    tipTx.sign([keypair]);

    const encodedTxs = [...swapTxs, tipTx].map((tx) => bs58.encode(tx.serialize()));

    const bundleRes = await fetch(`${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [encodedTxs],
      }),
    });

    const bundleData = await bundleRes.json();
    if (bundleData.error) {
      return { success: false, error: bundleData.error.message || JSON.stringify(bundleData.error) };
    }

    const bundleId = bundleData.result;
    console.log(`[JITO] Bundle submitted: ${bundleId}`);

    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const statusRes = await fetch(`${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });
        const statusData = await statusRes.json();
        const statuses = statusData?.result?.value;
        if (statuses?.length > 0) {
          const status = statuses[0];
          if (status.confirmation_status === "confirmed" || status.confirmation_status === "finalized") {
            return { success: true, bundleId };
          }
          if (status.err) {
            return { success: false, bundleId, error: "Bundle reverted ($0 cost)" };
          }
        }
      } catch {}
    }

    return { success: false, bundleId, error: "Status unknown after 30s" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── Execute opportunity ─────────────────────────────────
async function executeOpportunity(result: ScanResult) {
  const startTime = Date.now();
  totalOpportunities++;

  console.log(
    `[SCANNER] 🎯 ${result.legs}-LEG: ${result.route} | $${result.entryAmount} → $${result.exitAmount.toFixed(2)} | profit: $${result.estimatedProfit.toFixed(4)}`
  );

  const balance = await getUsdcBalance();
  if (balance < result.entryRaw) {
    console.warn(`[SCANNER] Insufficient USDC: ${balance / 1e6} < ${result.entryRaw / 1e6}`);
    return;
  }

  if (CONFIG.MEV_DRY_RUN) {
    console.log(`[DRY-RUN] Would submit: ${result.route} | $${result.estimatedProfit.toFixed(4)}`);
    await supabase.from("bundle_results").insert({
      route: result.route,
      entry_amount: result.entryAmount,
      exit_amount: result.exitAmount,
      profit: result.estimatedProfit,
      jito_tip: CONFIG.JITO_TIP / LAMPORTS_PER_SOL,
      status: "dry_run",
      tx_signature: null,
      trigger_tx: `scan_${result.legs}leg_${Date.now()}`,
      latency_ms: Date.now() - startTime,
    });
    return;
  }

  totalBundlesSent++;
  const bundleResult = await submitJitoBundle(result);
  const latencyMs = Date.now() - startTime;

  const outcome = {
    route: result.route,
    entry_amount: result.entryAmount,
    exit_amount: bundleResult.success ? result.exitAmount : result.entryAmount,
    profit: bundleResult.success ? result.estimatedProfit : 0,
    jito_tip: CONFIG.JITO_TIP / LAMPORTS_PER_SOL,
    status: bundleResult.success ? "success" : "reverted",
    tx_signature: bundleResult.bundleId || null,
    trigger_tx: `scan_${result.legs}leg_${Date.now()}`,
    latency_ms: latencyMs,
  };

  if (bundleResult.success) {
    totalProfit += result.estimatedProfit;
    usdcBalanceCache = 0; // force refresh
  }

  await supabase.from("bundle_results").insert(outcome);

  console.log(
    `[BUNDLE] ${outcome.status.toUpperCase()} | ${result.route} | $${outcome.profit.toFixed(4)} | ${latencyMs}ms${
      bundleResult.error ? ` | ${bundleResult.error}` : ""
    }`
  );
}

// ── Main scanner loop ───────────────────────────────────
async function startScanner() {
  const allPairs = generateScanPairs();
  const batchSize = CONFIG.SCANNER_BATCH_SIZE;

  console.log(`[SCANNER] ${ALL_SCAN_TOKENS.length} tokens (${ARB_INTERMEDIATE_TOKENS.length} blue-chip + ${MEMECOIN_TOKENS.length} memecoin)`);
  console.log(`[SCANNER] ${allPairs.length} triangular pairs + ${ALL_SCAN_TOKENS.length} direct pairs`);
  console.log(`[SCANNER] Entry sizes: ${ENTRY_SIZES_USDC.map((e) => "$" + e / 1e6).join(", ")}`);
  console.log(`[SCANNER] Memecoin safety: max $25 entry, 1% slippage, quote validation`);
  console.log(`[SCANNER] Interval: ${CONFIG.SCANNER_INTERVAL_MS}ms | Batch: ${batchSize}`);

  let pairIndex = 0;
  let directIndex = 0;
  let entryIndex = 0;

  while (true) {
    totalScans++;
    const entryAmount = ENTRY_SIZES_USDC[entryIndex % ENTRY_SIZES_USDC.length];
    entryIndex++;

    const allResults: ScanResult[] = [];

    // ── 2-leg direct scans ──────────────────────────────
    const directBatch: Promise<ScanResult | null>[] = [];
    for (let i = 0; i < Math.min(batchSize, ALL_SCAN_TOKENS.length); i++) {
      const token = ALL_SCAN_TOKENS[directIndex % ALL_SCAN_TOKENS.length];
      directIndex++;
      directBatch.push(scan2Leg(token.mint, token.symbol, entryAmount));
    }

    // ── 3-leg triangular scans ──────────────────────────
    const triBatch: Promise<ScanResult | null>[] = [];
    for (let i = 0; i < batchSize; i++) {
      const pair = allPairs[pairIndex % allPairs.length];
      pairIndex++;
      triBatch.push(scan3Leg(pair.tokenA, pair.symbolA, pair.tokenB, pair.symbolB, entryAmount));
    }

    const [directResults, triResults] = await Promise.all([
      Promise.all(directBatch),
      Promise.all(triBatch),
    ]);

    for (const r of directResults) {
      if (r && r.estimatedProfit >= CONFIG.MIN_PROFIT) {
        total2Leg++;
        allResults.push(r);
      }
    }
    for (const r of triResults) {
      if (r && r.estimatedProfit >= CONFIG.MIN_PROFIT) {
        total3Leg++;
        allResults.push(r);
      }
    }

    // Execute the best opportunity found this cycle
    if (allResults.length > 0) {
      allResults.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
      await executeOpportunity(allResults[0]);
    }

    await sleep(CONFIG.SCANNER_INTERVAL_MS);
  }
}

// ── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Continuous Arb Scanner v2");
console.log("═══════════════════════════════════════════════════");
console.log(`[SCANNER] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[SCANNER] Min profit: $${CONFIG.MIN_PROFIT}`);
console.log(`[SCANNER] Jito tip: ${CONFIG.JITO_TIP} lamports`);
console.log(`[SCANNER] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log("═══════════════════════════════════════════════════");

startScanner();

// Heartbeat
setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | scans=${totalScans} | 2leg=${total2Leg} | 3leg=${total3Leg} | opps=${totalOpportunities} | bundles=${totalBundlesSent} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);
