/**
 * RICKY TRADES — Continuous Triangular Arb Scanner
 *
 * Scans all token pairs continuously via Jupiter Quote API (free, no RPC needed).
 * Finds USDC → TokenA → TokenB → USDC triangular arb opportunities.
 * Submits profitable routes as atomic Jito bundles.
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
  ARB_INTERMEDIATE_TOKENS,
  generateScanPairs,
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

let totalScans = 0;
let totalOpportunities = 0;
let totalBundlesSent = 0;
let totalProfit = 0;

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function getUsdcBalance(): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.amount || 0);
  } catch {
    return 0;
  }
}

// ── Jupiter helpers ─────────────────────────────────────
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

// ── Scan a single triangular route ──────────────────────
interface ScanResult {
  route: string;
  tokenA: string;
  symbolA: string;
  tokenB: string;
  symbolB: string;
  quotes: any[];
  entryAmount: number;
  exitAmount: number;
  estimatedProfit: number;
}

async function scanTriangularRoute(
  tokenA: string,
  symbolA: string,
  tokenB: string,
  symbolB: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    // Leg 1: USDC → TokenA
    const q1 = await getJupiterQuote(USDC_MINT, tokenA, entryAmount);
    if (!q1) return null;

    // Leg 2: TokenA → TokenB
    const q2 = await getJupiterQuote(tokenA, tokenB, Number(q1.outAmount));
    if (!q2) return null;

    // Leg 3: TokenB → USDC
    const q3 = await getJupiterQuote(tokenB, USDC_MINT, Number(q2.outAmount));
    if (!q3) return null;

    const exitAmount = Number(q3.outAmount);
    const tipUSD = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
    const profitRaw = exitAmount - entryAmount;
    const profitUSD = profitRaw / 1_000_000 - tipUSD;

    if (profitUSD <= 0) return null;

    return {
      route: `USDC → ${symbolA} → ${symbolB} → USDC`,
      tokenA,
      symbolA,
      tokenB,
      symbolB,
      quotes: [q1, q2, q3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUSD,
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
    const [swapTx1Buf, swapTx2Buf, swapTx3Buf] = await Promise.all([
      getJupiterSwapTx(result.quotes[0]),
      getJupiterSwapTx(result.quotes[1]),
      getJupiterSwapTx(result.quotes[2]),
    ]);

    if (!swapTx1Buf || !swapTx2Buf || !swapTx3Buf) {
      return { success: false, error: "Failed to get swap transactions" };
    }

    const tx1 = VersionedTransaction.deserialize(swapTx1Buf);
    const tx2 = VersionedTransaction.deserialize(swapTx2Buf);
    const tx3 = VersionedTransaction.deserialize(swapTx3Buf);

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

    tx1.sign([keypair]);
    tx2.sign([keypair]);
    tx3.sign([keypair]);
    tipTx.sign([keypair]);

    const encodedTxs = [tx1, tx2, tx3, tipTx].map((tx) => bs58.encode(tx.serialize()));

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

    // Poll for status (up to 30s)
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
    `[SCANNER] 🎯 OPPORTUNITY: ${result.route} | $${result.estimatedProfit.toFixed(4)} profit`
  );

  // Check USDC balance
  const balance = await getUsdcBalance();
  if (balance < CONFIG.SCANNER_ENTRY_USDC) {
    console.warn(`[SCANNER] Insufficient USDC: ${balance / 1e6} < ${CONFIG.SCANNER_ENTRY_USDC / 1e6}`);
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
      trigger_tx: `scan_${Date.now()}`,
      latency_ms: Date.now() - startTime,
    });
    return;
  }

  // LIVE — submit Jito bundle
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
    trigger_tx: `scan_${Date.now()}`,
    latency_ms: latencyMs,
  };

  if (bundleResult.success) {
    totalProfit += result.estimatedProfit;
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
  const entryAmount = CONFIG.SCANNER_ENTRY_USDC;
  const batchSize = CONFIG.SCANNER_BATCH_SIZE;

  console.log(`[SCANNER] ${allPairs.length} token pairs to scan`);
  console.log(`[SCANNER] Entry: $${entryAmount / 1e6} USDC | Batch: ${batchSize} pairs | Interval: ${CONFIG.SCANNER_INTERVAL_MS}ms`);

  let pairIndex = 0;

  while (true) {
    // Take next batch of pairs
    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(allPairs[pairIndex % allPairs.length]);
      pairIndex++;
    }

    totalScans++;

    // Scan all pairs in batch concurrently (both directions)
    const scanPromises = batch.flatMap((pair) => [
      scanTriangularRoute(pair.tokenA, pair.symbolA, pair.tokenB, pair.symbolB, entryAmount),
      scanTriangularRoute(pair.tokenB, pair.symbolB, pair.tokenA, pair.symbolA, entryAmount),
    ]);

    const results = await Promise.all(scanPromises);
    const opportunities = results.filter((r): r is ScanResult => r !== null);

    if (opportunities.length > 0) {
      // Pick the best one
      opportunities.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
      await executeOpportunity(opportunities[0]);
    }

    await sleep(CONFIG.SCANNER_INTERVAL_MS);
  }
}

// ── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Continuous Triangular Arb Scanner");
console.log("═══════════════════════════════════════════════════");
console.log(`[SCANNER] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[SCANNER] Entry size: $${CONFIG.SCANNER_ENTRY_USDC / 1e6} USDC`);
console.log(`[SCANNER] Min profit: $${CONFIG.MIN_PROFIT}`);
console.log(`[SCANNER] Jito tip: ${CONFIG.JITO_TIP} lamports`);
console.log(`[SCANNER] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log(`[SCANNER] Scan interval: ${CONFIG.SCANNER_INTERVAL_MS}ms`);
console.log(`[SCANNER] Batch size: ${CONFIG.SCANNER_BATCH_SIZE} pairs/cycle`);
console.log(`[SCANNER] Tokens: ${ARB_INTERMEDIATE_TOKENS.map((t) => t.symbol).join(", ")}`);
console.log("═══════════════════════════════════════════════════");

startScanner();

// Heartbeat
setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | scans=${totalScans} | opportunities=${totalOpportunities} | bundles=${totalBundlesSent} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);
