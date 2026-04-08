/**
 * RICKY TRADES — Signal Detection Layer
 *
 * Detects market dislocations that create arb opportunities:
 * 1. Whale swaps (large trades that move prices)
 * 2. Spread pulses (buy/sell gap widening — returns executable results)
 * 3. Stablecoin depeg (USDC/USDT drift from 1:1)
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
import { getJupiterQuote, ScanResult } from "./scanner-strategies";
import { getTokenName } from "./utils";

// ── Signal types ────────────────────────────────────────
export interface Signal {
  type: "whale" | "spread" | "depeg";
  tokenMint: string;
  tokenSymbol: string;
  strength: number;
  detail: string;
  timestamp: number;
}

export type SignalCallback = (signal: Signal) => void;

// ── Whale Signal Monitor ────────────────────────────────
export function startWhaleMonitor(connection: Connection, onSignal: SignalCallback) {
  function subscribe() {
    try {
      const wsId = connection.onLogs(
        "all",
        (logInfo) => {
          if (logInfo.err) return;

          const logs = logInfo.logs.join(" ");
          let matchedDex: string | null = null;

          for (const [name, prog] of Object.entries(DEX_PROGRAMS)) {
            if (logs.includes(prog.id)) {
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
          parseWhaleSwap(connection, logInfo.signature, matchedDex, onSignal);
        },
        "confirmed"
      );

      console.log(`[SIGNALS] Whale monitor active (WebSocket subscription ${wsId})`);

      let lastLogTime = Date.now();
      const healthCheck = setInterval(() => {
        if (Date.now() - lastLogTime > 120_000) {
          console.warn("[SIGNALS] No whale logs for 120s, resubscribing...");
          try { connection.removeOnLogsListener(wsId); } catch {}
          clearInterval(healthCheck);
          setTimeout(subscribe, 2000);
        }
        lastLogTime = Date.now();
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

    if (amountUSD < CONFIG.WHALE_THRESHOLD) return;
    if (tokenInMint === tokenOutMint) return;
    if (STABLECOIN_MINTS.has(tokenInMint) && STABLECOIN_MINTS.has(tokenOutMint)) return;

    let targetMint: string;
    if (!STABLECOIN_MINTS.has(tokenInMint) && tokenInMint !== SOL_MINT) {
      targetMint = tokenInMint;
    } else if (!STABLECOIN_MINTS.has(tokenOutMint) && tokenOutMint !== SOL_MINT) {
      targetMint = tokenOutMint;
    } else {
      targetMint = tokenInMint === SOL_MINT ? tokenInMint : tokenOutMint;
    }
    const targetSymbol = getTokenName(targetMint);

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
    // Silent fail
  }
}

// ── Spread Pulse Scanner ────────────────────────────────
// Instead of just signaling, this directly returns executable ScanResults
// when it finds a profitable round-trip at production sizes.
function estimateProfitUsd(entryAmount: number, exitAmount: number): number {
  const tipUsd = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
  return (exitAmount - entryAmount) / 1_000_000 - tipUsd;
}

export async function findSpreadOpportunities(onSignal: SignalCallback): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const prodSizes = [5_000_000, 10_000_000, 25_000_000, 50_000_000]; // $5, $10, $25, $50

  for (const token of ALL_SCAN_TOKENS) {
    try {
      // Quick probe at $10 to detect spread
      const probeAmount = 10_000_000;
      const buyProbe = await getJupiterQuote(USDC_MINT, token.mint, probeAmount, 30);
      if (!buyProbe) continue;

      const tokenAmount = Number(buyProbe.outAmount);
      const sellProbe = await getJupiterQuote(token.mint, USDC_MINT, tokenAmount, 30);
      if (!sellProbe) continue;

      const probeExit = Number(sellProbe.outAmount);
      const spreadPct = (probeAmount - probeExit) / probeAmount;

      // Only pursue if spread is tight enough (< 0.1%)
      if (spreadPct >= 0.001) continue;

      // Log as signal for visibility
      onSignal({
        type: "spread",
        tokenMint: token.mint,
        tokenSymbol: token.symbol,
        strength: spreadPct <= 0 ? 1.0 : 0.5,
        detail: `spread=${(spreadPct * 100).toFixed(4)}% ($${(probeExit / 1e6).toFixed(4)} exit on $10 entry)`,
        timestamp: Date.now(),
      });

      // USE THE PROBE QUOTES DIRECTLY if already profitable at $10
      const probeProfitUsd = estimateProfitUsd(probeAmount, probeExit);
      if (probeProfitUsd >= CONFIG.MIN_PROFIT) {
        results.push({
          route: `USDC →[spread] ${token.symbol} →[spread] USDC`,
          legs: 2,
          quotes: [buyProbe, sellProbe],
          entryAmount: probeAmount / 1_000_000,
          exitAmount: probeExit / 1_000_000,
          estimatedProfit: probeProfitUsd,
          entryRaw: probeAmount,
          strategy: "spread",
        });
      }

      for (const size of prodSizes) {
        if (size === probeAmount) continue; // Already handled above
        try {
          const buyQ = await getJupiterQuote(USDC_MINT, token.mint, size, 30);
          if (!buyQ) {
            console.log(`[SPREAD-DEBUG] ${token.symbol} $${size/1e6}: buy quote failed`);
            continue;
          }

          const sellQ = await getJupiterQuote(token.mint, USDC_MINT, Number(buyQ.outAmount), 30);
          if (!sellQ) {
            console.log(`[SPREAD-DEBUG] ${token.symbol} $${size/1e6}: sell quote failed`);
            continue;
          }

          const exitAmount = Number(sellQ.outAmount);
          const ratio = exitAmount / size;
          if (ratio > 2 || ratio < 0.7) {
            console.log(`[SPREAD-DEBUG] ${token.symbol} $${size/1e6}: bad ratio ${ratio.toFixed(4)}`);
            continue;
          }

          const profitUsd = estimateProfitUsd(size, exitAmount);
          if (profitUsd >= CONFIG.MIN_PROFIT) {
            console.log(`[SPREAD] ✓ ${token.symbol} $${size/1e6}: profit=$${profitUsd.toFixed(4)}`);
            results.push({
              route: `USDC →[spread] ${token.symbol} →[spread] USDC`,
              legs: 2,
              quotes: [buyQ, sellQ],
              entryAmount: size / 1_000_000,
              exitAmount: exitAmount / 1_000_000,
              estimatedProfit: profitUsd,
              entryRaw: size,
              strategy: "spread",
            });
          } else {
            console.log(`[SPREAD-DEBUG] ${token.symbol} $${size/1e6}: profit=$${profitUsd.toFixed(4)} < min=$${CONFIG.MIN_PROFIT}`);
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

// ── Stablecoin Depeg Scanner ────────────────────────────
// Returns executable results when USDC/USDT depeg is profitable
export async function findDepegOpportunities(onSignal: SignalCallback): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  try {
    const probeAmount = 100_000_000; // $100 probe

    const q1 = await getJupiterQuote(USDC_MINT, USDT_MINT, probeAmount, 5);
    if (!q1) return results;

    const q2 = await getJupiterQuote(USDT_MINT, USDC_MINT, probeAmount, 5);
    if (!q2) return results;

    const usdcToUsdt = Number(q1.outAmount) / probeAmount;
    const usdtToUsdc = Number(q2.outAmount) / probeAmount;

    if (usdcToUsdt <= 1.0003 && usdtToUsdc <= 1.0003) return results;

    const bestDirection = usdcToUsdt > usdtToUsdc ? "USDC→USDT→USDC" : "USDT→USDC→USDT";
    const bestRate = Math.max(usdcToUsdt, usdtToUsdc);

    onSignal({
      type: "depeg",
      tokenMint: usdcToUsdt > usdtToUsdc ? USDT_MINT : USDC_MINT,
      tokenSymbol: usdcToUsdt > usdtToUsdc ? "USDT" : "USDC",
      strength: Math.min(1, (bestRate - 1) * 100),
      detail: `${bestDirection} rate=${bestRate.toFixed(6)} (${((bestRate - 1) * 100).toFixed(3)}% premium)`,
      timestamp: Date.now(),
    });

    // Try at production sizes
    const sizes = [25_000_000, 50_000_000]; // $25, $50
    for (const size of sizes) {
      try {
        if (usdcToUsdt > usdtToUsdc) {
          // USDC → USDT → USDC
          const buyQ = await getJupiterQuote(USDC_MINT, USDT_MINT, size, 5);
          if (!buyQ) continue;
          const sellQ = await getJupiterQuote(USDT_MINT, USDC_MINT, Number(buyQ.outAmount), 5);
          if (!sellQ) continue;

          const exitAmount = Number(sellQ.outAmount);
          const profitUsd = estimateProfitUsd(size, exitAmount);
          if (profitUsd >= CONFIG.MIN_PROFIT) {
            results.push({
              route: `USDC → USDT → USDC (depeg)`,
              legs: 2,
              quotes: [buyQ, sellQ],
              entryAmount: size / 1_000_000,
              exitAmount: exitAmount / 1_000_000,
              estimatedProfit: profitUsd,
              entryRaw: size,
              strategy: "depeg",
            });
          }
        } else {
          // USDT → USDC → USDT (but we hold USDC, so: USDC → buy USDT cheap → sell USDT for more USDC)
          const buyQ = await getJupiterQuote(USDC_MINT, USDT_MINT, size, 5);
          if (!buyQ) continue;
          const sellQ = await getJupiterQuote(USDT_MINT, USDC_MINT, Number(buyQ.outAmount), 5);
          if (!sellQ) continue;

          const exitAmount = Number(sellQ.outAmount);
          const profitUsd = estimateProfitUsd(size, exitAmount);
          if (profitUsd >= CONFIG.MIN_PROFIT) {
            results.push({
              route: `USDC → USDT → USDC (depeg)`,
              legs: 2,
              quotes: [buyQ, sellQ],
              entryAmount: size / 1_000_000,
              exitAmount: exitAmount / 1_000_000,
              estimatedProfit: profitUsd,
              entryRaw: size,
              strategy: "depeg",
            });
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Silent
  }

  return results;
}
