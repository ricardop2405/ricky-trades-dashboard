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
  scanDirect,
  scanDirectWithNearMiss,
} from "./scanner-strategies";
import { Signal, startWhaleMonitor, checkSpreadPulse, checkDepeg } from "./signals";
import { sleep } from "./utils";

const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  wsEndpoint: CONFIG.HELIUS_WS,
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ── Stats ───────────────────────────────────────────────
let totalScans = 0;
let totalDirect = 0;
let totalDexDiff = 0;
let total3Leg = 0;
let totalCrossStable = 0;
let totalNearMisses = 0;
let totalOpportunities = 0;
let totalBundlesSent = 0;
let totalProfit = 0;
let totalWhaleSignals = 0;
let totalSpreadSignals = 0;
let totalDepegSignals = 0;
let usdcBalanceCache = 0;
let lastBalanceCheck = 0;

// ── Signal queue ────────────────────────────────────────
const signalQueue: Signal[] = [];
const MAX_SIGNAL_QUEUE = 50;

function onSignal(signal: Signal) {
  // Dedupe: don't queue same token within 5 seconds
  const recent = signalQueue.find(
    (s) => s.tokenMint === signal.tokenMint && Date.now() - s.timestamp < 5_000
  );
  if (recent) return;

  if (signalQueue.length >= MAX_SIGNAL_QUEUE) {
    signalQueue.shift(); // Drop oldest
  }
  signalQueue.push(signal);

  if (signal.type === "whale") totalWhaleSignals++;
  else if (signal.type === "spread") totalSpreadSignals++;
  else if (signal.type === "depeg") totalDepegSignals++;

  console.log(
    `[SIGNAL] ${signal.type.toUpperCase()} | ${signal.tokenSymbol} | strength=${signal.strength.toFixed(2)} | ${signal.detail}`
  );
}

// ── Balance ─────────────────────────────────────────────
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
    const mint = new PublicKey(USDC_MINT);
    const parsedAccounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint });

    usdcBalanceCache = parsedAccounts.value.reduce((sum, { account }) => {
      return sum + Number(account.data.parsed.info.tokenAmount.amount || 0);
    }, 0);
    lastBalanceCheck = Date.now();

    console.log(`[BALANCE] USDC: $${(usdcBalanceCache / 1e6).toFixed(2)}`);
    return usdcBalanceCache;
  } catch (error) {
    console.error(`[BALANCE] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return usdcBalanceCache;
  }
}

// ── Jito bundle submission ──────────────────────────────
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
    const swapBuffers = await Promise.all(result.quotes.map((q) => getJupiterSwapTx(q)));
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

// ── Signal-driven scan ──────────────────────────────────
// When a signal fires, we immediately scan that specific token
// at multiple entry sizes for an atomic arb opportunity.
async function scanFromSignal(signal: Signal): Promise<ScanResult | null> {
  const results: ScanResult[] = [];

  // Spread/depeg signals = confirmed arb exists, use LARGER sizes to overcome Jito tip
  // Whale signals = speculative, start small
  let sizes: number[];
  if (signal.type === "spread" || signal.type === "depeg") {
    // Bigger sizes = more absolute profit from the % spread
    sizes = [10_000_000, 25_000_000, 50_000_000];
  } else if (signal.strength > 0.7) {
    sizes = [5_000_000, 10_000_000, 25_000_000, 50_000_000];
  } else {
    sizes = [2_000_000, 5_000_000, 10_000_000, 25_000_000];
  }

  // Skip scanning stablecoins directly (USDC→USDC makes no sense)
  if (signal.tokenMint === USDC_MINT) return null;

  const scanPromises = sizes.map((size) =>
    scanDirect(signal.tokenMint, signal.tokenSymbol, size)
  );

  const scanResults = await Promise.all(scanPromises);
  for (const result of scanResults) {
    if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
      results.push(result);
    }
  }

  // Also try cross-stable for the signaled token
  const crossResults = await Promise.all(
    sizes.slice(0, 2).map((size) =>
      scanCrossStable(signal.tokenMint, signal.tokenSymbol, size)
    )
  );
  for (const result of crossResults) {
    if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
      results.push(result);
    }
  }

  if (results.length === 0) return null;

  results.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
  return results[0];
}

// ── Main loop ───────────────────────────────────────────
async function startScanner() {
  const allPairs = generateScanPairs();
  const batchSize = CONFIG.SCANNER_BATCH_SIZE;

  console.log(`[SCANNER] ${ALL_SCAN_TOKENS.length} tokens (${ARB_INTERMEDIATE_TOKENS.length} blue-chip + ${ALL_SCAN_TOKENS.length - ARB_INTERMEDIATE_TOKENS.length} memecoin)`);
  console.log(`[SCANNER] Strategies: signal-driven + direct, dex-diff, cross-stable, 3leg-tri`);
  console.log(`[SCANNER] ${allPairs.length} triangular pairs | Batch: ${batchSize}`);
  console.log(`[SCANNER] Entry sizes: ${ENTRY_SIZES_USDC.map((a) => `$${a / 1e6}`).join(", ")}`);
  console.log(`[SCANNER] Interval: ${CONFIG.SCANNER_INTERVAL_MS}ms`);
  console.log(`[SCANNER] RPC: ${CONFIG.HELIUS_HTTP.replace(/api-key=.*/, "api-key=***")}`);
  console.log(`[SCANNER] WS: ${CONFIG.HELIUS_WS.replace(/api-key=.*/, "api-key=***")}`);

  // Startup balance check
  const startupBalance = await getUsdcBalance();
  console.log(`[SCANNER] Startup USDC balance: $${(startupBalance / 1e6).toFixed(2)}`);

  // Start signal monitors
  startWhaleMonitor(connection, onSignal);
  console.log("[SCANNER] Whale signal monitor started");

  // Start periodic spread + depeg checks
  const spreadInterval = setInterval(async () => {
    try {
      await checkSpreadPulse(onSignal);
    } catch (e) {
      console.error(`[SIGNALS] Spread check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 15_000); // Every 15s

  const depegInterval = setInterval(async () => {
    try {
      await checkDepeg(onSignal);
    } catch (e) {
      console.error(`[SIGNALS] Depeg check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 10_000); // Every 10s

  // Initial spread + depeg check
  checkSpreadPulse(onSignal).catch(() => {});
  checkDepeg(onSignal).catch(() => {});

  let pairIndex = 0;
  let tokenIndex = 0;
  let entryIndex = 0;
  let dexPairIndex = 0;
  let strategyRotation = 0;

  while (true) {
    totalScans++;

    // ── PRIORITY 1: Process signal queue ──
    while (signalQueue.length > 0) {
      const signal = signalQueue.shift()!;

      // Skip stale signals (> 10 seconds old)
      if (Date.now() - signal.timestamp > 10_000) continue;

      console.log(`[SCANNER] Processing ${signal.type} signal for ${signal.tokenSymbol}...`);
      const result = await scanFromSignal(signal);
      if (result) {
        if (signal.type === "whale") totalDirect++;
        else if (signal.type === "spread") totalDirect++;
        else if (signal.type === "depeg") totalCrossStable++;
        await executeOpportunity(result);
      }
    }

    // ── PRIORITY 2: Background scanning ──
    const entryAmount = ENTRY_SIZES_USDC[entryIndex % ENTRY_SIZES_USDC.length];
    entryIndex++;

    const allResults: ScanResult[] = [];
    const strategy = strategyRotation % 4;
    strategyRotation++;

    if (strategy === 0) {
      // Direct scan with near-miss logging
      const directBatch: Promise<{ result: ScanResult | null; nearMiss?: { route: string; profitUsd: number; entryUsd: number } }>[] = [];

      for (let i = 0; i < Math.min(batchSize, ALL_SCAN_TOKENS.length); i++) {
        const token = ALL_SCAN_TOKENS[tokenIndex % ALL_SCAN_TOKENS.length];
        tokenIndex++;
        directBatch.push(scanDirectWithNearMiss(token.mint, token.symbol, entryAmount));
      }

      const directResults = await Promise.all(directBatch);
      for (const { result, nearMiss } of directResults) {
        if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
          totalDirect++;
          allResults.push(result);
        } else if (nearMiss) {
          totalNearMisses++;
          if (totalNearMisses <= 20 || totalNearMisses % 50 === 0) {
            console.log(
              `[NEAR-MISS] ${nearMiss.route} | $${nearMiss.entryUsd} | gap: $${nearMiss.profitUsd.toFixed(4)}`
            );
          }
        }
      }
    } else if (strategy === 1) {
      // Dex differential
      const dexBatch: Promise<ScanResult | null>[] = [];
      for (let i = 0; i < Math.min(batchSize, ALL_SCAN_TOKENS.length); i++) {
        const token = ALL_SCAN_TOKENS[tokenIndex % ALL_SCAN_TOKENS.length];
        tokenIndex++;
        const pair = getDexPair(dexPairIndex++);
        dexBatch.push(scanDexDifferential(token.mint, token.symbol, entryAmount, pair));
      }
      const dexResults = await Promise.all(dexBatch);
      for (const result of dexResults) {
        if (result && result.estimatedProfit >= CONFIG.MIN_PROFIT) {
          totalDexDiff++;
          allResults.push(result);
        }
      }
    } else if (strategy === 2) {
      // Cross-stable
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
      // 3-leg triangular
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

// ── Boot ────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Signal-Driven Arb Scanner v6");
console.log("═══════════════════════════════════════════════════");
console.log(`[SCANNER] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[SCANNER] Min profit: $${CONFIG.MIN_PROFIT}`);
console.log(`[SCANNER] Jito tip: ${CONFIG.JITO_TIP} lamports`);
console.log(`[SCANNER] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log("═══════════════════════════════════════════════════");

startScanner();

setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | scans=${totalScans} | signals: whale=${totalWhaleSignals} spread=${totalSpreadSignals} depeg=${totalDepegSignals} | direct=${totalDirect} | dexDiff=${totalDexDiff} | 3leg=${total3Leg} | xstable=${totalCrossStable} | nearMiss=${totalNearMisses} | opps=${totalOpportunities} | bundles=${totalBundlesSent} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);
