import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIG } from "./config";
import { MEMECOIN_TOKENS, SOL_MINT, USDC_MINT, USDT_MINT } from "./constants";

const MEMECOIN_MINTS = new Set(MEMECOIN_TOKENS.map((token) => token.mint));
const JUPITER_QUOTE_ENDPOINTS = [
  "https://lite-api.jup.ag/swap/v1/quote",
  "https://api.jup.ag/swap/v1/quote",
  "https://quote-api.jup.ag/v6/quote",
] as const;

export interface ScanResult {
  route: string;
  legs: number;
  quotes: any[];
  entryAmount: number;
  exitAmount: number;
  estimatedProfit: number;
  entryRaw: number;
  strategy: string;
}

export const SCANNER_DEX_LABELS = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Orca Whirlpool",
  "Orca V2",
  "Meteora DLMM",
  "Meteora",
] as const;

export type DexLabel = (typeof SCANNER_DEX_LABELS)[number];

export interface DexPair {
  buyDex: DexLabel;
  sellDex: DexLabel;
}

export interface ProbeResult {
  supported: boolean;
  endpoint?: string;
  reason?: string;
}

export const DEX_ARB_PAIRS: DexPair[] = [
  { buyDex: "Raydium CLMM", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium" },
  { buyDex: "Raydium CP", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium CP" },
  { buyDex: "Raydium", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Raydium" },
  { buyDex: "Raydium CLMM", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Raydium CLMM" },
  { buyDex: "Orca Whirlpool", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Orca Whirlpool" },
  { buyDex: "Raydium", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium CLMM", sellDex: "Raydium" },
  { buyDex: "Raydium CP", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium CLMM", sellDex: "Raydium CP" },
];

async function fetchQuoteWithFallbacks(urlSuffix: string): Promise<{ data: any | null; endpoint?: string; reason?: string }> {
  let lastReason = "unknown";

  for (const endpoint of JUPITER_QUOTE_ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${endpoint}?${urlSuffix}`, {
          signal: controller.signal,
          headers: {
            "User-Agent": "ricky-trades-scanner/1.0",
          },
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          lastReason = `HTTP ${res.status}`;
          if ((res.status === 429 || res.status >= 500) && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          }
          break;
        }

        const data = await res.json();
        if (data?.error) {
          lastReason = String(data.error);
          break;
        }

        return { data, endpoint };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
      }
    }
  }

  return { data: null, reason: lastReason };
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 30,
  options: {
    onlyDirectRoutes?: boolean;
    dexes?: string[];
    excludeDexes?: string[];
    restrictIntermediateTokens?: boolean;
  } = {}
): Promise<any | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });

  if (options.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");
  if (options.restrictIntermediateTokens) params.set("restrictIntermediateTokens", "true");
  if (options.dexes?.length) params.set("dexes", options.dexes.join(","));
  if (options.excludeDexes?.length) params.set("excludeDexes", options.excludeDexes.join(","));

  const { data } = await fetchQuoteWithFallbacks(params.toString());
  return data;
}

function getMaxEntry(mint: string): number {
  return MEMECOIN_MINTS.has(mint) ? 25_000_000 : 100_000_000;
}

function isSafeQuote(inputAmount: number, outputAmount: number, isMemecoin: boolean): boolean {
  const ratio = outputAmount / inputAmount;
  if (ratio > 2) return false;
  if (isMemecoin && ratio < 0.7) return false;
  if (!isMemecoin && ratio < 0.5) return false;
  return true;
}

function estimateProfitUsd(entryAmount: number, exitAmount: number): number {
  const tipUsd = (CONFIG.JITO_TIP / LAMPORTS_PER_SOL) * CONFIG.SOL_PRICE_USD;
  return (exitAmount - entryAmount) / 1_000_000 - tipUsd;
}

export async function probeDexSupport(dexLabel: string): Promise<ProbeResult> {
  const params = new URLSearchParams({
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amount: "10000000",
    slippageBps: "300",
    onlyDirectRoutes: "true",
    dexes: dexLabel,
  });

  const { data, endpoint, reason } = await fetchQuoteWithFallbacks(params.toString());
  if (!data || Number(data.outAmount || 0) <= 0) {
    return {
      supported: false,
      endpoint,
      reason: reason || "no quote returned",
    };
  }

  return {
    supported: true,
    endpoint,
  };
}

export function getDexPair(index: number): DexPair {
  return DEX_ARB_PAIRS[index % DEX_ARB_PAIRS.length];
}

export async function scanDexDifferential(
  tokenMint: string,
  tokenSymbol: string,
  entryAmount: number,
  dexPair: DexPair
): Promise<ScanResult | null> {
  try {
    const isMemecoin = MEMECOIN_MINTS.has(tokenMint);
    if (entryAmount > getMaxEntry(tokenMint)) return null;

    const slippage = isMemecoin ? 100 : 50;
    const buyQuote = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, slippage, {
      onlyDirectRoutes: true,
      dexes: [dexPair.buyDex],
    });
    if (!buyQuote) return null;

    const sellQuote = await getJupiterQuote(tokenMint, USDC_MINT, Number(buyQuote.outAmount), slippage, {
      onlyDirectRoutes: true,
      dexes: [dexPair.sellDex],
    });
    if (!sellQuote) return null;

    const exitAmount = Number(sellQuote.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return null;

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);
    if (profitUsd <= 0) return null;

    return {
      route: `USDC →[${dexPair.buyDex}] ${tokenSymbol} →[${dexPair.sellDex}] USDC`,
      legs: 2,
      quotes: [buyQuote, sellQuote],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUsd,
      entryRaw: entryAmount,
      strategy: "dex_diff",
    };
  } catch {
    return null;
  }
}

export async function scanCrossStable(
  tokenMint: string,
  tokenSymbol: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    const isMemecoin = MEMECOIN_MINTS.has(tokenMint);
    if (isMemecoin && entryAmount > 25_000_000) return null;

    const slippage = isMemecoin ? 100 : 30;
    const q1 = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, slippage);
    if (!q1) return null;

    const q2 = await getJupiterQuote(tokenMint, USDT_MINT, Number(q1.outAmount), slippage);
    if (!q2) return null;

    const q3 = await getJupiterQuote(USDT_MINT, USDC_MINT, Number(q2.outAmount), 10);
    if (!q3) return null;

    const exitAmount = Number(q3.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return null;

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);
    if (profitUsd <= 0) return null;

    return {
      route: `USDC → ${tokenSymbol} → USDT → USDC`,
      legs: 3,
      quotes: [q1, q2, q3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUsd,
      entryRaw: entryAmount,
      strategy: "cross_stable",
    };
  } catch {
    return null;
  }
}

export async function scan3Leg(
  tokenA: string,
  symbolA: string,
  tokenB: string,
  symbolB: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    const hasMemecoin = MEMECOIN_MINTS.has(tokenA) || MEMECOIN_MINTS.has(tokenB);
    if (hasMemecoin && entryAmount > 25_000_000) return null;

    const slippage = hasMemecoin ? 100 : 30;
    const q1 = await getJupiterQuote(USDC_MINT, tokenA, entryAmount, slippage);
    if (!q1) return null;

    const q2 = await getJupiterQuote(tokenA, tokenB, Number(q1.outAmount), slippage);
    if (!q2) return null;

    const q3 = await getJupiterQuote(tokenB, USDC_MINT, Number(q2.outAmount), slippage);
    if (!q3) return null;

    const exitAmount = Number(q3.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, hasMemecoin)) return null;

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);
    if (profitUsd <= 0) return null;

    return {
      route: `USDC → ${symbolA} → ${symbolB} → USDC`,
      legs: 3,
      quotes: [q1, q2, q3],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUsd,
      entryRaw: entryAmount,
      strategy: "triangular",
    };
  } catch {
    return null;
  }
}

// ── NEW: Direct 2-leg scan (Jupiter best-route, no DEX restriction) ──
// Lets Jupiter pick the optimal route across ALL available DEXes.
// Same atomic safety: if exit < entry + tip, Jito bundle reverts at $0 cost.
export async function scanDirect(
  tokenMint: string,
  tokenSymbol: string,
  entryAmount: number
): Promise<ScanResult | null> {
  try {
    const isMemecoin = MEMECOIN_MINTS.has(tokenMint);
    if (entryAmount > getMaxEntry(tokenMint)) return null;

    const slippage = isMemecoin ? 100 : 30;

    const buyQuote = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, slippage);
    if (!buyQuote) return null;

    const sellQuote = await getJupiterQuote(tokenMint, USDC_MINT, Number(buyQuote.outAmount), slippage);
    if (!sellQuote) return null;

    const exitAmount = Number(sellQuote.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return null;

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);
    if (profitUsd <= 0) return null;

    return {
      route: `USDC →[best] ${tokenSymbol} →[best] USDC`,
      legs: 2,
      quotes: [buyQuote, sellQuote],
      entryAmount: entryAmount / 1_000_000,
      exitAmount: exitAmount / 1_000_000,
      estimatedProfit: profitUsd,
      entryRaw: entryAmount,
      strategy: "direct",
    };
  } catch {
    return null;
  }
}

// ── Near-miss logger ──
export async function scanDirectWithNearMiss(
  tokenMint: string,
  tokenSymbol: string,
  entryAmount: number
): Promise<{ result: ScanResult | null; nearMiss?: { route: string; profitUsd: number; entryUsd: number } }> {
  try {
    const isMemecoin = MEMECOIN_MINTS.has(tokenMint);
    if (entryAmount > getMaxEntry(tokenMint)) return { result: null };

    const slippage = isMemecoin ? 100 : 30;

    const buyQuote = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, slippage);
    if (!buyQuote) return { result: null };

    const sellQuote = await getJupiterQuote(tokenMint, USDC_MINT, Number(buyQuote.outAmount), slippage);
    if (!sellQuote) return { result: null };

    const exitAmount = Number(sellQuote.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return { result: null };

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);

    if (profitUsd <= 0) {
      if (profitUsd > -0.10) {
        return {
          result: null,
          nearMiss: {
            route: `USDC →[best] ${tokenSymbol} →[best] USDC`,
            profitUsd,
            entryUsd: entryAmount / 1_000_000,
          },
        };
      }
      return { result: null };
    }

    return {
      result: {
        route: `USDC →[best] ${tokenSymbol} →[best] USDC`,
        legs: 2,
        quotes: [buyQuote, sellQuote],
        entryAmount: entryAmount / 1_000_000,
        exitAmount: exitAmount / 1_000_000,
        estimatedProfit: profitUsd,
        entryRaw: entryAmount,
        strategy: "direct",
      },
    };
  } catch {
    return { result: null };
  }
}
