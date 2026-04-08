import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIG } from "./config";
import {
  MEMECOIN_TOKENS,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
} from "./constants";

const MEMECOIN_MINTS = new Set(MEMECOIN_TOKENS.map((token) => token.mint));

export interface QuoteOptions {
  onlyDirectRoutes?: boolean;
  dexes?: string[];
  excludeDexes?: string[];
  restrictIntermediateTokens?: boolean;
}

export interface DexPair {
  buyDex: string;
  sellDex: string;
}

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

export const SCANNER_DEXES = [
  "Raydium V4",
  "Raydium CLMM",
  "Raydium CP",
  "Orca Whirlpool",
  "Meteora DLMM",
  "Meteora Pools",
] as const;

export const DEX_ARB_PAIRS: DexPair[] = [
  { buyDex: "Raydium CLMM", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium V4", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Raydium V4" },
  { buyDex: "Raydium CP", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium CLMM", sellDex: "Raydium CP" },
  { buyDex: "Meteora Pools", sellDex: "Raydium V4" },
  { buyDex: "Raydium V4", sellDex: "Meteora Pools" },
];

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function routeMatchesDex(quote: any, dexLabel: string): boolean {
  const routeLabels = (quote?.routePlan ?? [])
    .map((plan: any) => String(plan?.swapInfo?.label ?? ""))
    .filter(Boolean);

  if (routeLabels.length === 0) return false;

  const normalizedDex = normalizeLabel(dexLabel);
  return routeLabels.every((label: string) => {
    const normalizedRoute = normalizeLabel(label);
    return normalizedRoute.includes(normalizedDex) || normalizedDex.includes(normalizedRoute);
  });
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

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 30,
  options: QuoteOptions = {}
): Promise<any | null> {
  try {
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

    const res = await fetch(`https://quote-api.jup.ag/v6/quote?${params.toString()}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (data?.error) return null;

    return data;
  } catch {
    return null;
  }
}

export async function probeDexSupport(dexLabel: string): Promise<boolean> {
  const quote = await getJupiterQuote(USDC_MINT, SOL_MINT, 1_000_000, 50, {
    onlyDirectRoutes: true,
    dexes: [dexLabel],
    restrictIntermediateTokens: true,
  });

  return Boolean(quote && routeMatchesDex(quote, dexLabel));
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
      restrictIntermediateTokens: true,
    });
    if (!buyQuote || !routeMatchesDex(buyQuote, dexPair.buyDex)) return null;

    const sellQuote = await getJupiterQuote(tokenMint, USDC_MINT, Number(buyQuote.outAmount), slippage, {
      onlyDirectRoutes: true,
      dexes: [dexPair.sellDex],
      restrictIntermediateTokens: true,
    });
    if (!sellQuote || !routeMatchesDex(sellQuote, dexPair.sellDex)) return null;

    const exitAmount = Number(sellQuote.outAmount);
    if (!isSafeQuote(entryAmount, exitAmount, isMemecoin)) return null;

    const profitUsd = estimateProfitUsd(entryAmount, exitAmount);
    if (profitUsd <= 0) return null;

    return {
      route: `USDC → ${tokenSymbol} via ${dexPair.buyDex} → USDC via ${dexPair.sellDex}`,
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

    const q3 = await getJupiterQuote(USDT_MINT, USDC_MINT, Number(q2.outAmount), 10, {
      onlyDirectRoutes: true,
      restrictIntermediateTokens: true,
    });
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
