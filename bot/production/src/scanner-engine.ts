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
  ALL_SCAN_TOKENS,
  ARB_INTERMEDIATE_TOKENS,
  ENTRY_SIZES_USDC,
  generateScanPairs,
  JITO_TIP_ACCOUNTS,
  USDC_MINT,
} from "./constants";
import {
  getDexPair,
  probeDexSupport,
  ScanResult,
  scan3Leg,
  SCANNER_DEX_LABELS,
  scanCrossStable,
  scanDexDifferential,
} from "./scanner-strategies";
import { sleep } from "./utils";

const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

let totalScans = 0;
let totalDexDiff = 0;
let total3Leg = 0;
let totalCrossStable = 0;
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
  if (Date.now() - lastBalanceCheck < 30_000 && usdcBalanceCache > 0) {
    return usdcBalanceCache;
  }

  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
    console.log(`[BALANCE] Checking ATA: ${ata.toBase58()} for wallet ${keypair.publicKey.toBase58()}`);
    const balance = await connection.getTokenAccountBalance(ata);
    usdcBalanceCache = Number(balance.value.amount || 0);
    lastBalanceCheck = Date.now();
    console.log(`[BALANCE] USDC balance: ${usdcBalanceCache / 1e6} (raw: ${usdcBalanceCache})`);
    return usdcBalanceCache;
  } catch (error) {
    console.error(`[BALANCE] Failed to fetch USDC balance: ${error instanceof Error ? error.message : String(error)}`);
    // Try alternative: direct RPC call
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
      const accountInfo = await connection.getAccountInfo(ata);
      if (!accountInfo) {
        console.error(`[BALANCE] USDC token account does NOT exist at ${ata.toBase58()}. You need to create it by sending USDC to the wallet.`);
      }
    } catch {}
    return usdcBalanceCache;
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

async function submitJitoBundle(result: ScanResult): Promise<{
  success: boolean;
  bundleId?: string;
  error?: string;
}> {
  try {
    const swapBuffers = await Promise.all(result.quotes.map((quote) => getJupiterSwapTx(quote)));
    if (swapBuffers.some((buffer) => !buffer)) {
      return { success: false, error: "Failed to get swap transactions" };
    }

    const swapTxs = swapBuffers.map((buffer) => VersionedTransaction.deserialize(buffer!));
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
      } catch {
        continue;
      }
    }

    return { success: false, bundleId, error: "Status unknown after 30s" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeOpportunity(result: ScanResult) {
  const startTime = Date.now();
  totalOpportunities++;

  console.log(
    `[SCANNER] 🎯 ${result.strategy} | ${result.route} | $${result.entryAmount} → $${result.exitAmount.toFixed(4)} | profit: $${result.estimatedProfit.toFixed(4)}`
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
      trigger_tx: `scan_${result.strategy}_${Date.now()}`,
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
    trigger_tx: `scan_${result.strategy}_${Date.now()}`,
    latency_ms: latencyMs,
  };

  if (bundleResult.success) {
    totalProfit += result.estimatedProfit;
    usdcBalanceCache = 0;
  }

  await supabase.from("bundle_results").insert(outcome);
  console.log(
    `[BUNDLE] ${outcome.status.toUpperCase()} | ${result.route} | $${outcome.profit.toFixed(4)} | ${latencyMs}ms${
      bundleResult.error ? ` | ${bundleResult.error}` : ""
    }`
  );
}

async function logDexSupport() {
  const results = await Promise.all(
    SCANNER_DEX_LABELS.map(async (dex) => ({ dex, probe: await probeDexSupport(dex) }))
  );

  for (const result of results) {
    console.log(
      result.probe.supported
        ? `[SCANNER] ✓ DEX OK: ${result.dex} via ${result.probe.endpoint}`
        : `[SCANNER] ✗ DEX unavailable: ${result.dex}${result.probe.endpoint ? ` via ${result.probe.endpoint}` : ""}${result.probe.reason ? ` | ${result.probe.reason}` : ""}`
    );
  }
}

async function startScanner() {
  const allPairs = generateScanPairs();
  const batchSize = CONFIG.SCANNER_BATCH_SIZE;

  console.log(`[SCANNER] ${ALL_SCAN_TOKENS.length} tokens (${ARB_INTERMEDIATE_TOKENS.length} blue-chip + ${ALL_SCAN_TOKENS.length - ARB_INTERMEDIATE_TOKENS.length} memecoin)`);
  console.log(`[SCANNER] Strategies: dex-diff, cross-stable, 3leg-tri`);
  console.log(`[SCANNER] ${allPairs.length} triangular pairs + ${ALL_SCAN_TOKENS.length} dex-diff + ${ALL_SCAN_TOKENS.length} cross-stable`);
  console.log(`[SCANNER] Entry sizes: ${ENTRY_SIZES_USDC.map((amount) => `$${amount / 1e6}`).join(", ")}`);
  console.log(`[SCANNER] Interval: ${CONFIG.SCANNER_INTERVAL_MS}ms | Batch: ${batchSize}`);

  await logDexSupport();

  let pairIndex = 0;
  let tokenIndex = 0;
  let entryIndex = 0;
  let dexPairIndex = 0;
  let strategyRotation = 0;

  while (true) {
    totalScans++;
    const entryAmount = ENTRY_SIZES_USDC[entryIndex % ENTRY_SIZES_USDC.length];
    entryIndex++;

    const allResults: ScanResult[] = [];
    const strategy = strategyRotation % 3;
    strategyRotation++;

    if (strategy === 0) {
      const dexBatch: Promise<ScanResult | null>[] = [];

      for (let i = 0; i < Math.min(batchSize, ALL_SCAN_TOKENS.length); i++) {
        const token = ALL_SCAN_TOKENS[tokenIndex % ALL_SCAN_TOKENS.length];
        tokenIndex++;

        const primaryPair = getDexPair(dexPairIndex++);
        dexBatch.push(scanDexDifferential(token.mint, token.symbol, entryAmount, primaryPair));

        if (entryAmount <= 5_000_000) {
          const secondaryPair = getDexPair(dexPairIndex++);
          dexBatch.push(scanDexDifferential(token.mint, token.symbol, entryAmount, secondaryPair));
        }
      }

      const dexResults = await Promise.all(dexBatch);
      for (const result of dexResults) {
        if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
          totalDexDiff++;
          allResults.push(result);
        }
      }
    } else if (strategy === 1) {
      const crossBatch: Promise<ScanResult | null>[] = [];

      for (let i = 0; i < Math.min(batchSize, ALL_SCAN_TOKENS.length); i++) {
        const token = ALL_SCAN_TOKENS[tokenIndex % ALL_SCAN_TOKENS.length];
        tokenIndex++;
        crossBatch.push(scanCrossStable(token.mint, token.symbol, entryAmount));
      }

      const crossResults = await Promise.all(crossBatch);
      for (const result of crossResults) {
        if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
          totalCrossStable++;
          allResults.push(result);
        }
      }
    } else {
      const triBatch: Promise<ScanResult | null>[] = [];

      for (let i = 0; i < batchSize; i++) {
        const pair = allPairs[pairIndex % allPairs.length];
        pairIndex++;
        triBatch.push(scan3Leg(pair.tokenA, pair.symbolA, pair.tokenB, pair.symbolB, entryAmount));
      }

      const triResults = await Promise.all(triBatch);
      for (const result of triResults) {
        if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
          total3Leg++;
          allResults.push(result);
        }
      }
    }

    if (allResults.length > 0) {
      allResults.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
      await executeOpportunity(allResults[0]);
    }

    await sleep(CONFIG.SCANNER_INTERVAL_MS);
  }
}

console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Continuous Arb Scanner v4");
console.log("═══════════════════════════════════════════════════");
console.log(`[SCANNER] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[SCANNER] Min profit: $${CONFIG.MIN_PROFIT}`);
console.log(`[SCANNER] Jito tip: ${CONFIG.JITO_TIP} lamports`);
console.log(`[SCANNER] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log("═══════════════════════════════════════════════════");

startScanner();

setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | scans=${totalScans} | dexDiff=${totalDexDiff} | 3leg=${total3Leg} | xstable=${totalCrossStable} | opps=${totalOpportunities} | bundles=${totalBundlesSent} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);
