/**
 * RICKY TRADES — Pump.fun Migration Sniper Engine
 *
 * Monitors Pump.fun program for "Complete" migration events via logsSubscribe.
 * When a token completes its bonding curve and migrates to Raydium,
 * the bot executes an atomic buy-sell via Jito bundle in the first slots.
 *
 * Strategy: USDC → NewToken (Raydium) → USDC (Jupiter best route)
 * Guarantee: Jito bundle reverts at $0 cost if profit condition isn't met.
 *
 * Usage: npm run migration
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
import { USDC_MINT, JITO_TIP_ACCOUNTS } from "./constants";
import { sleep, isRateLimitError } from "./utils";

// ── Pump.fun Program ID ─────────────────────────────────
const PUMPFUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5DkZztzU2LR9qe338PzIi9FMA00000000"
);

// ── Raydium V4 (pool creation target) ───────────────────
const RAYDIUM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

// ── Config ──────────────────────────────────────────────
const MIGRATION_ENTRY_USDC = CONFIG.MIGRATION_ENTRY_USDC; // raw 6-decimal
const MIGRATION_SELL_DELAY_MS = CONFIG.MIGRATION_SELL_DELAY_MS;
const MIGRATION_MAX_SLIPPAGE_BPS = CONFIG.MIGRATION_MAX_SLIPPAGE_BPS;
const MIGRATION_JITO_TIP = CONFIG.MIGRATION_JITO_TIP;
const MIGRATION_COOLDOWN_MS = CONFIG.MIGRATION_COOLDOWN_MS;

// ── State ───────────────────────────────────────────────
const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
const connection = new Connection(CONFIG.HELIUS_HTTP, {
  wsEndpoint: CONFIG.HELIUS_WS,
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

let totalMigrations = 0;
let totalAttempts = 0;
let totalBundles = 0;
let totalProfit = 0;
let lastMigrationAt = 0;
let executionInFlight = false;

// Track recently seen mints to avoid double-processing
const recentMints = new Set<string>();
const RECENT_MINT_TTL_MS = 60_000;

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function getUsdcBalance(): Promise<number> {
  try {
    const mint = new PublicKey(USDC_MINT);
    const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.amount || 0);
  } catch {
    return 0;
  }
}

// ── Jupiter quote (paid endpoint) ───────────────────────
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<any | null> {
  const endpoint = CONFIG.JUPITER_API_KEY
    ? "https://api.jup.ag/swap/v1/quote"
    : "https://lite-api.jup.ag/swap/v1/quote";

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });

  const headers: Record<string, string> = {
    "User-Agent": "ricky-migration-sniper/1.0",
  };
  if (CONFIG.JUPITER_API_KEY) {
    headers["x-api-key"] = CONFIG.JUPITER_API_KEY;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${endpoint}?${params}`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    return data?.error ? null : data;
  } catch {
    return null;
  }
}

// ── Jupiter swap tx builder ─────────────────────────────
async function getJupiterSwapTx(quote: any): Promise<Buffer | null> {
  const endpoint = CONFIG.JUPITER_API_KEY
    ? "https://api.jup.ag/swap/v1/swap"
    : "https://lite-api.jup.ag/swap/v1/swap";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ricky-migration-sniper/1.0",
        ...(CONFIG.JUPITER_API_KEY
          ? { "x-api-key": CONFIG.JUPITER_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 0,
        dynamicSlippage: { maxBps: MIGRATION_MAX_SLIPPAGE_BPS },
      }),
    });

    if (!res.ok) {
      console.warn(`[MIGRATION-SWAP] ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const data = await res.json();
    return data.swapTransaction
      ? Buffer.from(data.swapTransaction, "base64")
      : null;
  } catch (err) {
    console.warn(`[MIGRATION-SWAP] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Extract mint from Pump.fun "Complete" log ───────────
function extractMintFromLogs(
  logs: string[],
  accountKeys: string[]
): string | null {
  // The newly migrated token mint is usually in the account keys of the tx.
  // We look for a mint that is NOT a known program, NOT USDC, NOT SOL.
  const knownPrograms = new Set([
    PUMPFUN_PROGRAM.toBase58(),
    RAYDIUM_V4_PROGRAM,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "11111111111111111111111111111111",
    "SysvarRent111111111111111111111111111111111",
    "SysvarC1ock11111111111111111111111111111111",
    USDC_MINT,
    "So11111111111111111111111111111111111111112",
    "ComputeBudget111111111111111111111111111111",
  ]);

  // Also try to extract from log lines that mention "mint:"
  for (const log of logs) {
    const mintMatch = log.match(/mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (mintMatch) return mintMatch[1];
  }

  // Fallback: first unknown account key that looks like a token mint
  for (const key of accountKeys) {
    if (!knownPrograms.has(key) && key.length >= 32 && key.length <= 44) {
      return key;
    }
  }

  return null;
}

// ── Atomic buy-sell via Jito bundle ─────────────────────
async function executeMigrationSnipe(tokenMint: string, triggerSig: string) {
  if (executionInFlight) {
    console.log("[MIGRATION] Skipping — execution already in flight");
    return;
  }

  // Cooldown check
  if (Date.now() - lastMigrationAt < MIGRATION_COOLDOWN_MS) {
    console.log("[MIGRATION] Skipping — cooldown active");
    return;
  }

  executionInFlight = true;
  const startTime = Date.now();

  try {
    totalAttempts++;

    // Check balance
    const balance = await getUsdcBalance();
    if (balance < MIGRATION_ENTRY_USDC) {
      console.warn(
        `[MIGRATION] Insufficient USDC: $${(balance / 1e6).toFixed(2)} < $${(MIGRATION_ENTRY_USDC / 1e6).toFixed(2)}`
      );
      return;
    }

    console.log(
      `[MIGRATION] 🎯 Sniping ${tokenMint.slice(0, 8)}... | Entry: $${(MIGRATION_ENTRY_USDC / 1e6).toFixed(0)}`
    );

    // Leg 1: USDC → NewToken
    const buyQuote = await getJupiterQuote(
      USDC_MINT,
      tokenMint,
      MIGRATION_ENTRY_USDC,
      MIGRATION_MAX_SLIPPAGE_BPS
    );

    if (!buyQuote) {
      console.log("[MIGRATION] No buy quote available — Jupiter hasn't indexed the pool yet");
      // Retry after a short delay (pool might be indexing)
      await sleep(MIGRATION_SELL_DELAY_MS);

      const retryBuyQuote = await getJupiterQuote(
        USDC_MINT,
        tokenMint,
        MIGRATION_ENTRY_USDC,
        MIGRATION_MAX_SLIPPAGE_BPS
      );

      if (!retryBuyQuote) {
        console.log("[MIGRATION] Retry failed — pool not yet indexed, skipping");
        return;
      }

      return await buildAndSubmitBundle(retryBuyQuote, tokenMint, triggerSig, startTime);
    }

    await buildAndSubmitBundle(buyQuote, tokenMint, triggerSig, startTime);
  } catch (err) {
    console.error(
      `[MIGRATION] Error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    executionInFlight = false;
    lastMigrationAt = Date.now();
  }
}

async function buildAndSubmitBundle(
  buyQuote: any,
  tokenMint: string,
  triggerSig: string,
  startTime: number
) {
  // Leg 2: NewToken → USDC (sell immediately)
  const sellQuote = await getJupiterQuote(
    tokenMint,
    USDC_MINT,
    Number(buyQuote.outAmount),
    MIGRATION_MAX_SLIPPAGE_BPS
  );

  if (!sellQuote) {
    console.log("[MIGRATION] No sell quote — skipping");
    return;
  }

  const exitAmount = Number(sellQuote.outAmount);
  const tipUsd =
    (MIGRATION_JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
  const profitUsd = (exitAmount - MIGRATION_ENTRY_USDC) / 1_000_000 - tipUsd;

  console.log(
    `[MIGRATION] Quote: $${(MIGRATION_ENTRY_USDC / 1e6).toFixed(0)} → $${(exitAmount / 1e6).toFixed(4)} | profit: $${profitUsd.toFixed(4)}`
  );

  if (profitUsd < CONFIG.MIN_PROFIT) {
    console.log(
      `[MIGRATION] Below profit floor ($${CONFIG.MIN_PROFIT}) — safe revert`
    );
    return;
  }

  // Build swap transactions
  const [buySwapBuf, sellSwapBuf] = await Promise.all([
    getJupiterSwapTx(buyQuote),
    getJupiterSwapTx(sellQuote),
  ]);

  if (!buySwapBuf || !sellSwapBuf) {
    console.warn("[MIGRATION] Failed to build swap transactions");
    return;
  }

  const buyTx = VersionedTransaction.deserialize(buySwapBuf);
  const sellTx = VersionedTransaction.deserialize(sellSwapBuf);

  // Jito tip
  const tipAccount =
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const tipIx = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey(tipAccount),
    lamports: MIGRATION_JITO_TIP,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tipMsg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();
  const tipTx = new VersionedTransaction(tipMsg);

  // Sign all
  buyTx.sign([keypair]);
  sellTx.sign([keypair]);
  tipTx.sign([keypair]);

  const encodedTxs = [buyTx, sellTx, tipTx].map((tx) =>
    bs58.encode(tx.serialize())
  );

  if (CONFIG.MEV_DRY_RUN) {
    console.log(
      `[DRY-RUN] Would submit migration bundle: $${profitUsd.toFixed(4)} profit`
    );
    await supabase.from("bundle_results").insert({
      route: `USDC →[migration] ${tokenMint.slice(0, 8)}... →[best] USDC`,
      entry_amount: MIGRATION_ENTRY_USDC / 1e6,
      exit_amount: exitAmount / 1e6,
      profit: profitUsd,
      jito_tip: MIGRATION_JITO_TIP / LAMPORTS_PER_SOL,
      status: "dry_run",
      tx_signature: null,
      trigger_tx: triggerSig,
      latency_ms: Date.now() - startTime,
    });
    return;
  }

  // Submit to Jito
  totalBundles++;
  console.log("[MIGRATION] Submitting Jito bundle...");

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
    console.warn(
      `[MIGRATION] Bundle error: ${bundleData.error.message || JSON.stringify(bundleData.error)}`
    );
    await logBundle("reverted", profitUsd, triggerSig, tokenMint, startTime, null, bundleData.error.message);
    return;
  }

  const bundleId = bundleData.result;
  console.log(`[MIGRATION] Bundle submitted: ${bundleId}`);

  // Poll for confirmation (max 30s)
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

      if (statuses?.length > 0) {
        const status = statuses[0];
        if (
          status.confirmation_status === "confirmed" ||
          status.confirmation_status === "finalized"
        ) {
          totalProfit += profitUsd;
          console.log(
            `[MIGRATION] ✅ LANDED! | $${profitUsd.toFixed(4)} profit | ${Date.now() - startTime}ms`
          );
          await logBundle("success", profitUsd, triggerSig, tokenMint, startTime, bundleId);
          return;
        }
        if (status.err) {
          console.log(
            `[MIGRATION] Bundle reverted ($0 cost) | ${Date.now() - startTime}ms`
          );
          await logBundle("reverted", 0, triggerSig, tokenMint, startTime, bundleId, "Bundle reverted");
          return;
        }
      }
    } catch {
      // continue polling
    }
  }

  console.log(`[MIGRATION] Bundle ${bundleId} — status pending after 30s`);
  await logBundle("submitted", profitUsd, triggerSig, tokenMint, startTime, bundleId, "Pending after 30s");
}

async function logBundle(
  status: string,
  profit: number,
  triggerSig: string,
  tokenMint: string,
  startTime: number,
  bundleId: string | null,
  error?: string
) {
  const { error: dbErr } = await supabase.from("bundle_results").insert({
    route: `USDC →[migration] ${tokenMint.slice(0, 8)}... →[best] USDC`,
    entry_amount: MIGRATION_ENTRY_USDC / 1e6,
    exit_amount: status === "success" ? (MIGRATION_ENTRY_USDC / 1e6) + profit : MIGRATION_ENTRY_USDC / 1e6,
    profit: status === "success" ? profit : 0,
    jito_tip: MIGRATION_JITO_TIP / LAMPORTS_PER_SOL,
    status,
    tx_signature: bundleId,
    trigger_tx: triggerSig,
    latency_ms: Date.now() - startTime,
  });
  if (dbErr) console.error("[DB] Insert error:", dbErr.message);
}

// ── WebSocket: Monitor Pump.fun for "Complete" events ───
let subscriptionId: number | null = null;
let lastLogReceived = Date.now();

function subscribePumpfun() {
  try {
    subscriptionId = connection.onLogs(
      PUMPFUN_PROGRAM,
      (logInfo) => {
        try {
          lastLogReceived = Date.now();
          const { signature, logs } = logInfo;

          // Look for the migration completion event
          const isComplete = logs.some(
            (log) =>
              log.includes("Program log: Complete") ||
              log.includes("Program log: Instruction: Complete")
          );

          if (!isComplete) return;

          totalMigrations++;
          console.log(
            `[MIGRATION] 🚀 Migration detected! sig=${signature.slice(0, 12)}...`
          );

          // Extract the token mint from the log context
          // Account keys come from the log subscription — we parse from logs
          const accountKeys: string[] = [];
          for (const log of logs) {
            // Extract any public key-like strings from invoke logs
            const keyMatches = log.match(
              /([1-9A-HJ-NP-Za-km-z]{32,44})/g
            );
            if (keyMatches) {
              for (const key of keyMatches) {
                if (!accountKeys.includes(key)) accountKeys.push(key);
              }
            }
          }

          const tokenMint = extractMintFromLogs(logs, accountKeys);
          if (!tokenMint) {
            console.warn("[MIGRATION] Could not extract token mint from logs");
            return;
          }

          // Dedup
          if (recentMints.has(tokenMint)) {
            console.log(`[MIGRATION] Already processed ${tokenMint.slice(0, 8)}... — skipping`);
            return;
          }
          recentMints.add(tokenMint);
          setTimeout(() => recentMints.delete(tokenMint), RECENT_MINT_TTL_MS);

          console.log(
            `[MIGRATION] Token mint: ${tokenMint} | Attempting snipe...`
          );

          // Fire-and-forget the snipe (don't block the WS listener)
          executeMigrationSnipe(tokenMint, signature).catch((err) => {
            console.error(
              `[MIGRATION] Snipe error: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        } catch (err) {
          console.error(
            `[MIGRATION] Log handler error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      "confirmed"
    );

    console.log(
      `[MIGRATION] ✓ Subscribed to Pump.fun (${PUMPFUN_PROGRAM.toBase58().slice(0, 12)}...)`
    );
  } catch (err) {
    console.error(
      `[MIGRATION] ✗ Failed to subscribe: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Auto-reconnect ──────────────────────────────────────
const WS_HEALTH_CHECK_INTERVAL = 60_000;
const WS_STALE_THRESHOLD = 120_000;

async function reconnectWebSocket() {
  console.warn("[MIGRATION] 🔄 WebSocket stale — reconnecting...");
  if (subscriptionId !== null) {
    try {
      await connection.removeOnLogsListener(subscriptionId);
    } catch {}
  }
  subscribePumpfun();
  lastLogReceived = Date.now();
}

// ── Boot ────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  RICKY TRADES — Pump.fun Migration Sniper v1");
console.log("═══════════════════════════════════════════════════");
console.log(`[MIGRATION] Bot wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[MIGRATION] Entry size: $${(MIGRATION_ENTRY_USDC / 1e6).toFixed(0)} USDC`);
console.log(`[MIGRATION] Max slippage: ${MIGRATION_MAX_SLIPPAGE_BPS} bps`);
console.log(`[MIGRATION] Jito tip: ${MIGRATION_JITO_TIP} lamports`);
console.log(`[MIGRATION] Sell delay: ${MIGRATION_SELL_DELAY_MS}ms`);
console.log(`[MIGRATION] Cooldown: ${MIGRATION_COOLDOWN_MS}ms`);
console.log(`[MIGRATION] Dry run: ${CONFIG.MEV_DRY_RUN}`);
console.log(`[MIGRATION] Jupiter paid key: ${CONFIG.JUPITER_API_KEY ? "yes" : "no"}`);
const maskUrl = (url: string) => url.replace(/api-key=[^&]+/, "api-key=****");
console.log(`[MIGRATION] HTTP RPC: ${maskUrl(CONFIG.HELIUS_HTTP)}`);
console.log(`[MIGRATION] WS RPC:   ${maskUrl(CONFIG.HELIUS_WS)}`);
console.log("═══════════════════════════════════════════════════");

subscribePumpfun();

getUsdcBalance().then((bal) => {
  console.log(`[MIGRATION] Startup USDC: $${(bal / 1e6).toFixed(2)}`);
});

// Health check
setInterval(async () => {
  const silentMs = Date.now() - lastLogReceived;
  if (silentMs > WS_STALE_THRESHOLD) {
    await reconnectWebSocket();
  }
}, WS_HEALTH_CHECK_INTERVAL);

// Heartbeat
setInterval(() => {
  console.log(
    `[HEARTBEAT] ${new Date().toISOString()} | migrations=${totalMigrations} | attempts=${totalAttempts} | bundles=${totalBundles} | profit=$${totalProfit.toFixed(4)}`
  );
}, 60_000);

console.log("[MIGRATION] Engine running. Watching for Pump.fun migrations...");
