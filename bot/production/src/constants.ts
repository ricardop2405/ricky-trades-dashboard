// ── DEX Program IDs ─────────────────────────────────────
export const DEX_PROGRAMS: Record<string, { id: string; swapInstructions: string[] }> = {
  "Jupiter V6": {
    id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    swapInstructions: ["Instruction: Route", "Instruction: SharedAccountsRoute", "Instruction: ExactOutRoute"],
  },
  "Jupiter V4": {
    id: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
    swapInstructions: ["Instruction: Route"],
  },
  "Raydium V4": {
    id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    swapInstructions: ["Instruction: SwapBaseIn", "Instruction: SwapBaseOut", "Instruction: Swap"],
  },
  "Raydium CLMM": {
    id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    swapInstructions: ["Instruction: Swap", "Instruction: SwapV2"],
  },
  "Raydium CP": {
    id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    swapInstructions: ["Instruction: Swap", "Instruction: SwapBaseInput", "Instruction: SwapBaseOutput"],
  },
  "Orca Whirlpool": {
    id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    swapInstructions: ["Instruction: Swap", "Instruction: TwoHopSwap"],
  },
  "Meteora DLMM": {
    id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    swapInstructions: ["Instruction: Swap"],
  },
  "Meteora Pools": {
    id: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
    swapInstructions: ["Instruction: Swap"],
  },
};

// ── Token Mints ─────────────────────────────────────────
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const STABLECOIN_MINTS = new Set([USDC_MINT, USDT_MINT]);

export const TOKEN_NAMES: Record<string, string> = {
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
  [SOL_MINT]: "SOL",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": "PYTH",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE": "ORCA",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey": "MNDE",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": "jitoSOL",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1": "bSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": "RENDER",
  "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y": "SHDW",
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": "JTO",
  "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6": "TNSR",
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk": "WEN",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMP",
  "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC": "AI16Z",
  "Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs": "GRASS",
  "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P": "FARTCOIN",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": "JLP",
};

// ── Safe intermediate tokens for triangular arb ─────────
// Only high-liquidity tokens — no random memecoins
export const ARB_INTERMEDIATE_TOKENS: { mint: string; symbol: string }[] = [
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY" },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
  { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO" },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK" },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF" },
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "jitoSOL" },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL" },
  { mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", symbol: "bSOL" },
  { mint: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", symbol: "stSOL" },
  { mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", symbol: "RENDER" },
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH" },
  { mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", symbol: "ORCA" },
  { mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", symbol: "W" },
];

// ── Memecoin tokens (higher opportunity but need safety checks) ──
export const MEMECOIN_TOKENS: { mint: string; symbol: string }[] = [
  { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT" },
  { mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", symbol: "MEW" },
  { mint: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82", symbol: "BOME" },
  { mint: "3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN", symbol: "MOTHER" },
  { mint: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", symbol: "MOODENG" },
  { mint: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", symbol: "PNUT" },
  { mint: "A8C3xuqscfmyLrte3VVY3bSz1SARhS6kMqsJt4i1pump", symbol: "GIGA" },
  { mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", symbol: "TRUMP" },
  { mint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", symbol: "AI16Z" },
  { mint: "Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs", symbol: "GRASS" },
  { mint: "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P", symbol: "FARTCOIN" },
  { mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", symbol: "WBTC" },
  { mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", symbol: "JLP" },
];

// All tokens combined for scanning
export const ALL_SCAN_TOKENS: { mint: string; symbol: string }[] = [
  ...ARB_INTERMEDIATE_TOKENS,
  ...MEMECOIN_TOKENS,
];

// ── Token pairs for continuous scanning ─────────────────
export function generateScanPairs(): { tokenA: string; symbolA: string; tokenB: string; symbolB: string }[] {
  const pairs: { tokenA: string; symbolA: string; tokenB: string; symbolB: string }[] = [];
  for (let i = 0; i < ALL_SCAN_TOKENS.length; i++) {
    for (let j = i + 1; j < ALL_SCAN_TOKENS.length; j++) {
      pairs.push({
        tokenA: ALL_SCAN_TOKENS[i].mint,
        symbolA: ALL_SCAN_TOKENS[i].symbol,
        tokenB: ALL_SCAN_TOKENS[j].mint,
        symbolB: ALL_SCAN_TOKENS[j].symbol,
      });
    }
  }
  return pairs;
}

// Multiple entry sizes to find opportunities at different scales
export const ENTRY_SIZES_USDC = [25_000_000, 50_000_000];

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiYDac1aR",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
