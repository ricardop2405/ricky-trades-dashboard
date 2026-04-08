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
  ENTRY_SIZES_USDC,
  STABLECOIN_MINTS,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
} from "./constants";
import { getJupiterQuote, ScanResult } from "./scanner-strategies";
import { getTokenName } from "./utils";

const SUPPORTED_SIGNAL_MINTS = new Set(ALL_SCAN_TOKENS.map((token) => token.mint));

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

    if (!SUPPORTED_SIGNAL_MINTS.has(targetMint)) return;

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

function getScannerExecutionFloorUsd(): number {
  return Math.max(CONFIG.MIN_PROFIT, CONFIG.SCANNER_MIN_PROFIT);
}

export async function findSpreadOpportunities(onSignal: SignalCallback): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const executionFloorUsd = getScannerExecutionFloorUsd();
  const probeThresholdUsd = executionFloorUsd * 0.4;
  const executionSizes = [...ENTRY_SIZES_USDC].sort((a, b) => a - b);

  for (const token of ALL_SCAN_TOKENS) {
    try {
      const tokenResults: ScanResult[] = [];

      // Quick probe at $10 to detect spread
      const probeAmount = 10_000_000;
      const buyProbe = await getJupiterQuote(USDC_MINT, token.mint, probeAmount, 30);
      if (!buyProbe) continue;

      const tokenAmount = Number(buyProbe.outAmount);
      const sellProbe = await getJupiterQuote(token.mint, USDC_MINT, tokenAmount, 30);
      if (!sellProbe) continue;

      const probeExit = Number(sellProbe.outAmount);
      const spreadPct = (probeAmount - probeExit) / probeAmount;
      const probeProfitUsd = estimateProfitUsd(probeAmount, probeExit);

      if (spreadPct >= 0 || probeProfitUsd < probeThresholdUsd) continue;

      for (const size of executionSizes) {
        try {
          await new Promise((r) => setTimeout(r, 200));

          const buyQ = await getJupiterQuote(USDC_MINT, token.mint, size, 30);
          if (!buyQ) continue;

          const sellQ = await getJupiterQuote(token.mint, USDC_MINT, Number(buyQ.outAmount), 30);
          if (!sellQ) continue;

          const exitAmount = Number(sellQ.outAmount);
          const ratio = exitAmount / size;
          if (ratio > 2 || ratio < 0.7) continue;

          const profitUsd = estimateProfitUsd(size, exitAmount);
          if (profitUsd >= executionFloorUsd) {
            console.log(`[SPREAD] ✓ ${token.symbol} $${size / 1e6}: profit=$${profitUsd.toFixed(4)}`);
            tokenResults.push({
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
            console.log(`[SPREAD-DEBUG] ${token.symbol} $${size / 1e6}: profit=$${profitUsd.toFixed(4)} < execution floor $${executionFloorUsd.toFixed(4)}`);
          }
        } catch {
          // continue
        }
      }

      if (tokenResults.length === 0) {
        console.log(`[SPREAD-DEBUG] ${token.symbol}: probe matched but no executable size passed profit/quote checks`);
        continue;
      }

      tokenResults.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
      const bestResult = tokenResults[0];

      onSignal({
        type: "spread",
        tokenMint: token.mint,
        tokenSymbol: token.symbol,
        strength: spreadPct <= 0 ? 1.0 : 0.5,
        detail: `spread=${(spreadPct * 100).toFixed(4)}% | best=$${bestResult.estimatedProfit.toFixed(4)} on $${bestResult.entryAmount.toFixed(0)} entry`,
        timestamp: Date.now(),
      });

      results.push(...tokenResults);
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
