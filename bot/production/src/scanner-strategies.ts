import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIG } from "./config";
import {
  MEMECOIN_TOKENS,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
} from "./constants";

const MEMECOIN_MINTS = new Set(MEMECOIN_TOKENS.map((token) => token.mint));

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

// ── Jupiter program IDs → labels (used for dexes param) ─
const PROGRAM_ID_TO_LABEL: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CP",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca V2",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora",
};

// These are the labels Jupiter accepts in the `dexes` query param
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

// All cross-venue pairs to probe for price differences
export const DEX_ARB_PAIRS: DexPair[] = [
  // Raydium variants vs Orca
  { buyDex: "Raydium CLMM", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium" },
  { buyDex: "Raydium CP", sellDex: "Orca Whirlpool" },
  { buyDex: "Orca Whirlpool", sellDex: "Raydium CP" },
  // Raydium vs Meteora
  { buyDex: "Raydium", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Raydium" },
  { buyDex: "Raydium CLMM", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Raydium CLMM" },
  // Orca vs Meteora
  { buyDex: "Orca Whirlpool", sellDex: "Meteora DLMM" },
  { buyDex: "Meteora DLMM", sellDex: "Orca Whirlpool" },
  // Raydium internal
  { buyDex: "Raydium", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium CLMM", sellDex: "Raydium" },
  { buyDex: "Raydium CP", sellDex: "Raydium CLMM" },
  { buyDex: "Raydium CLMM", sellDex: "Raydium CP" },
];

// ── Jupiter quote helper ────────────────────────────────
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

// ── Safety helpers ──────────────────────────────────────
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

// ── Probe: verify a DEX label works ─────────────────────
export async function probeDexSupport(dexLabel: string): Promise<boolean> {
  const quote = await getJupiterQuote(USDC_MINT, SOL_MINT, 1_000_000, 300, {
    onlyDirectRoutes: true,
    dexes: [dexLabel],
  });
  return quote !== null && Number(quote.outAmount || 0) > 0;
}

export function getDexPair(index: number): DexPair {
  return DEX_ARB_PAIRS[index % DEX_ARB_PAIRS.length];
}

// ── Strategy 1: DEX-vs-DEX price differential ───────────
// Buy on one DEX, sell on another — real venue arbitrage
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

    // Buy on DEX A
    const buyQuote = await getJupiterQuote(USDC_MINT, tokenMint, entryAmount, slippage, {
      onlyDirectRoutes: true,
      dexes: [dexPair.buyDex],
    });
    if (!buyQuote) return null;

    // Sell on DEX B
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

// ── Strategy 2: Cross-stablecoin ────────────────────────
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

// ── Strategy 3: Triangular ──────────────────────────────
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
