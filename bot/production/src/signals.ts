/**
 * RICKY TRADES — Signal Detection Layer
 *
 * Detects market dislocations that create arb opportunities:
 * 1. Whale swaps (large trades that move prices)
 * 2. Spread pulses (buy/sell gap widening on a token)
 * 3. Stablecoin depeg (USDC/USDT drift from 1:1)
 *
 * Signals are emitted to the scanner which then verifies with
 * atomic round-trip quotes before executing.
 */

import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIG } from "./config";
import {
  ALL_SCAN_TOKENS,
  DEX_PROGRAMS,
  STABLECOIN_MINTS,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
} from "./constants";
import { getJupiterQuote } from "./scanner-strategies";
import { getTokenName } from "./utils";

// ── Signal types ────────────────────────────────────────
export interface Signal {
  type: "whale" | "spread" | "depeg";
  tokenMint: string;
  tokenSymbol: string;
  strength: number; // 0-1, higher = more likely profitable
  detail: string;
  timestamp: number;
}

export type SignalCallback = (signal: Signal) => void;

// ── Whale Signal Monitor ────────────────────────────────
// Listens to Helius WebSocket for large swaps on DEX programs.
// When a whale moves a token, prices temporarily shift — that's our window.
export function startWhaleMonitor(connection: Connection, onSignal: SignalCallback) {
  const dexProgramIds = Object.values(DEX_PROGRAMS).map((d) => d.id);
  let wsActive = false;
  let lastLogTime = 0;

  function subscribe() {
    try {
      const wsId = connection.onLogs(
        "all",
        (logInfo) => {
          if (logInfo.err) return;

          // Check if this tx involves a DEX program
          const logs = logInfo.logs.join(" ");
          let matchedDex: string | null = null;

          for (const [name, prog] of Object.entries(DEX_PROGRAMS)) {
            if (logs.includes(prog.id)) {
              // Check for swap instructions
              for (const ix of prog.swapInstructions) {
                if (logs.includes(ix)) {
                  matchedDex = name;
                  break;
                }
              }
              if (matchedDex) break;
            }
          }

          if (!matchedDex) return;

          // We found a DEX swap — enqueue the signature for parsing
          const sig = logInfo.signature;
          parseWhaleSwap(connection, sig, matchedDex, onSignal);
        },
        "confirmed"
      );

      wsActive = true;
      console.log(`[SIGNALS] Whale monitor active (WebSocket subscription ${wsId})`);

      // Health check — if no logs for 120s, resubscribe
      const healthCheck = setInterval(() => {
        if (Date.now() - lastLogTime > 120_000 && lastLogTime > 0) {
          console.warn("[SIGNALS] No whale logs for 120s, resubscribing...");
          try {
            connection.removeOnLogsListener(wsId);
          } catch {}
          clearInterval(healthCheck);
          setTimeout(subscribe, 2000);
        }
      }, 30_000);

    } catch (error) {
      console.error(`[SIGNALS] Whale monitor failed: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(subscribe, 10_000);
    }
  }

  subscribe();
}

async function parseWhaleSwap(
  connection: Connection,
  signature: string,
  dex: string,
  onSignal: SignalCallback
) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta || tx.meta.err) return;

    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

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

    if (changes.length < 2) return;

    const spent = changes.filter((c) => c.diff < 0).sort((a, b) => a.diff - b.diff);
    const received = changes.filter((c) => c.diff > 0).sort((a, b) => b.diff - a.diff);
    if (!spent.length || !received.length) return;

    // Estimate USD value
    let amountUSD = 0;
    const tokenInMint = spent[0].mint;
    const tokenOutMint = received[0].mint;

    if (STABLECOIN_MINTS.has(tokenInMint)) {
      amountUSD = Math.abs(spent[0].diff);
    } else if (STABLECOIN_MINTS.has(tokenOutMint)) {
      amountUSD = Math.abs(received[0].diff);
    } else if (tokenInMint === SOL_MINT) {
      amountUSD = Math.abs(spent[0].diff) * CONFIG.SOL_PRICE_USD;
    } else if (tokenOutMint === SOL_MINT) {
      amountUSD = Math.abs(received[0].diff) * CONFIG.SOL_PRICE_USD;
    } else {
      const preSol = tx.meta.preBalances[0] / LAMPORTS_PER_SOL;
      const postSol = tx.meta.postBalances[0] / LAMPORTS_PER_SOL;
      amountUSD = Math.abs(postSol - preSol) * CONFIG.SOL_PRICE_USD;
    }

    // Only signal on whale-sized swaps (> $2000)
    if (amountUSD < CONFIG.WHALE_THRESHOLD) return;

    // Find the non-stablecoin token that was traded
    const targetMint = STABLECOIN_MINTS.has(tokenInMint) ? tokenOutMint : tokenInMint;
    const targetSymbol = getTokenName(targetMint);

    // Strength based on size: $2k = 0.3, $10k = 0.6, $50k+ = 1.0
    const strength = Math.min(1, amountUSD / 50_000 + 0.2);

    onSignal({
      type: "whale",
      tokenMint: targetMint,
      tokenSymbol: targetSymbol,
      strength,
      detail: `$${amountUSD.toFixed(0)} swap on ${dex} (${getTokenName(tokenInMint)} → ${getTokenName(tokenOutMint)})`,
      timestamp: Date.now(),
    });
  } catch {
    // Silent fail — don't block on RPC errors
  }
}

// ── Spread Pulse Monitor ────────────────────────────────
// Periodically checks buy vs sell quote gaps.
// When the spread widens, it signals a potential arb window.
export async function checkSpreadPulse(onSignal: SignalCallback) {
  const checkAmount = 10_000_000; // $10 test quote

  for (const token of ALL_SCAN_TOKENS) {
    try {
      // Get buy quote (USDC → Token)
      const buyQuote = await getJupiterQuote(USDC_MINT, token.mint, checkAmount, 30);
      if (!buyQuote) continue;

      // Get sell quote (Token → USDC) for same amount of tokens
      const tokenAmount = Number(buyQuote.outAmount);
      const sellQuote = await getJupiterQuote(token.mint, USDC_MINT, tokenAmount, 30);
      if (!sellQuote) continue;

      const exitAmount = Number(sellQuote.outAmount);
      const spreadPct = (checkAmount - exitAmount) / checkAmount;

      // Normal spread is 0.1-0.5%. If spread is < 0.05%, there might be an arb.
      // If spread is negative (exit > entry), definite arb signal.
      if (spreadPct < 0.001) {
        // Spread is < 0.1% — very tight, worth scanning at multiple sizes
        const strength = spreadPct <= 0 ? 1.0 : 0.5 + (0.001 - spreadPct) * 500;

        onSignal({
          type: "spread",
          tokenMint: token.mint,
          tokenSymbol: token.symbol,
          strength: Math.min(1, Math.max(0.3, strength)),
          detail: `spread=${(spreadPct * 100).toFixed(4)}% ($${(exitAmount / 1e6).toFixed(4)} exit on $10 entry)`,
          timestamp: Date.now(),
        });
      }
    } catch {
      continue;
    }
  }
}

// ── Stablecoin Depeg Monitor ────────────────────────────
// Checks USDC/USDT rate. Any drift > 0.05% creates a safe arb opportunity.
export async function checkDepeg(onSignal: SignalCallback) {
  try {
    const amount = 100_000_000; // $100

    // USDC → USDT
    const q1 = await getJupiterQuote(USDC_MINT, USDT_MINT, amount, 5);
    if (!q1) return;

    // USDT → USDC
    const q2 = await getJupiterQuote(USDT_MINT, USDC_MINT, amount, 5);
    if (!q2) return;

    const usdcToUsdt = Number(q1.outAmount) / amount;
    const usdtToUsdc = Number(q2.outAmount) / amount;

    // If either direction gives > 1.0005 (0.05% premium), there's a depeg arb
    if (usdcToUsdt > 1.0003 || usdtToUsdc > 1.0003) {
      const bestRate = Math.max(usdcToUsdt, usdtToUsdc);
      const direction = usdcToUsdt > usdtToUsdc ? "USDC→USDT" : "USDT→USDC";

      onSignal({
        type: "depeg",
        tokenMint: usdcToUsdt > usdtToUsdc ? USDT_MINT : USDC_MINT,
        tokenSymbol: usdcToUsdt > usdtToUsdc ? "USDT" : "USDC",
        strength: Math.min(1, (bestRate - 1) * 100),
        detail: `${direction} rate=${bestRate.toFixed(6)} (${((bestRate - 1) * 100).toFixed(3)}% premium)`,
        timestamp: Date.now(),
      });
    }
  } catch {
    // Silent
  }
}
