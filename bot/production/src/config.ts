import "dotenv/config";

// ── Only Limitless (Base Chain) env vars required ───────
const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const CONFIG = {
  // ── Supabase ──────────────────────────────────────────
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,

  // ── Solana / Jupiter Predict ──────────────────────────
  PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || "",
  HELIUS_HTTP: process.env.HELIUS_HTTP || process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com",
  HELIUS_WS:
    process.env.HELIUS_WS ||
    (process.env.HELIUS_HTTP
      ? process.env.HELIUS_HTTP.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://")
      : process.env.HELIUS_RPC
        ? process.env.HELIUS_RPC.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://")
        : "wss://api.mainnet-beta.solana.com"),
  JUP_PREDICT_API: process.env.JUP_PREDICT_API || "https://prediction-market-api.jup.ag/api/v1",
  JUP_PREDICT_API_KEY: process.env.JUP_PREDICT_API_KEY || "",
  JUP_USD_MINT: process.env.JUP_USD_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC

  // ── Arb Settings ──────────────────────────────────────
  ARB_AMOUNT: parseFloat(process.env.ARB_AMOUNT || "5"),
  MIN_SPREAD: parseFloat(process.env.MIN_SPREAD || "0.005"),
  SCAN_INTERVAL: parseInt(process.env.SCAN_INTERVAL || "2000"),
  SOL_PRICE_USD: parseFloat(process.env.SOL_PRICE_USD || "150"),

  // ── MEV / Jito Atomic Arb ─────────────────────────────
  MEV_DRY_RUN: process.env.MEV_DRY_RUN !== "false", // default true
  MEV_ENTRY_USDC: parseInt(process.env.MEV_ENTRY_USDC || "50000000"), // 50 USDC in raw (6 decimals)
  WHALE_THRESHOLD: parseFloat(process.env.WHALE_THRESHOLD || "5000"),
  JITO_TIP: parseInt(process.env.JITO_TIP || "25000"), // lamports (~$0.00375 at $150 SOL)
  MIN_PROFIT: parseFloat(process.env.MIN_PROFIT || "0.05"), // USD — align with the atomic profit safety guardrail
  JITO_BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf",
  MAX_PENDING_SIGNATURES: parseInt(process.env.MAX_PENDING_SIGNATURES || "200"),
  PARSED_TX_MIN_INTERVAL_MS: parseInt(process.env.PARSED_TX_MIN_INTERVAL_MS || "250"),
  MAX_GET_TX_RETRIES: parseInt(process.env.MAX_GET_TX_RETRIES || "3"),
  RATE_LIMIT_BACKOFF_MS: parseInt(process.env.RATE_LIMIT_BACKOFF_MS || "2000"),

  // ── Continuous Scanner ─────────────────────────────────
  SCANNER_ENABLED: process.env.SCANNER_ENABLED !== "false", // default true
  SCANNER_INTERVAL_MS: parseInt(process.env.SCANNER_INTERVAL_MS || "6000"),
  SCANNER_BATCH_SIZE: parseInt(process.env.SCANNER_BATCH_SIZE || "8"), // pairs per batch
  SCANNER_ENTRY_USDC: parseInt(process.env.SCANNER_ENTRY_USDC || "50000000"), // 50 USDC
  SCANNER_MIN_PROFIT: parseFloat(process.env.SCANNER_MIN_PROFIT || "0.01"),
  SCANNER_RATE_LIMIT_COOLDOWN_MS: parseInt(process.env.SCANNER_RATE_LIMIT_COOLDOWN_MS || "10000"),
  SCANNER_PENDING_COOLDOWN_MS: parseInt(process.env.SCANNER_PENDING_COOLDOWN_MS || "15000"),

  // ── Limitless (Base Chain) ────────────────────────────
  LIMITLESS_OWNER_ID: Number(process.env.LIMITLESS_OWNER_ID || 0),
  LIMITLESS_API: process.env.LIMITLESS_API || "https://api.limitless.exchange",
  LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY || "",
  BASE_RPC_URL: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  BASE_PRIVATE_KEY: process.env.BASE_PRIVATE_KEY || "",
  LIMITLESS_MIN_SPREAD: parseFloat(process.env.LIMITLESS_MIN_SPREAD || "0.015"),
  LIMITLESS_TRADE_SIZE_USD: parseFloat(process.env.LIMITLESS_TRADE_SIZE_USD || "5"),
  LIMITLESS_SCAN_INTERVAL_MS: parseInt(process.env.LIMITLESS_SCAN_INTERVAL_MS || "8000"),

  // Gnosis CTF on Base
  CTF_ADDRESS: process.env.CTF_ADDRESS || "0x7fFa3c445876EAC20215D109e42413e6a0b0D842",
  LIMITLESS_USDC: process.env.LIMITLESS_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

  // ── Gnosis Chain (Omen + Azuro) ──────────────────────
  GRAPH_API_KEY: process.env.GRAPH_API_KEY || "",
  GNOSIS_OMEN_SUBGRAPH_URL:
    process.env.GNOSIS_OMEN_SUBGRAPH_URL ||
    (process.env.GRAPH_API_KEY
      ? `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/9fUVQpFwzpdWS9bq5WkAnmKbNNcoBwatMR4yZq81pbbz`
      : ""),
  GNOSIS_PRIVATE_KEY: process.env.GNOSIS_PRIVATE_KEY || process.env.BASE_PRIVATE_KEY || "",
  GNOSIS_RPC_URL: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
  GNOSIS_MIN_SPREAD: parseFloat(process.env.GNOSIS_MIN_SPREAD || "0.01"),
  GNOSIS_TRADE_SIZE_USD: parseFloat(process.env.GNOSIS_TRADE_SIZE_USD || "10"),
  GNOSIS_SCAN_INTERVAL_MS: parseInt(process.env.GNOSIS_SCAN_INTERVAL_MS || "5000"),
  GNOSIS_DRY_RUN: process.env.GNOSIS_DRY_RUN !== "false",
} as const;
