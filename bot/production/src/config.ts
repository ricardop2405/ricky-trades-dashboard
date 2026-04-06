import "dotenv/config";

// Determine which engine is running based on the entry script
const scriptName = process.argv[1] || "";
const isLimitless = scriptName.includes("limitless");
const isMev = scriptName.includes("mev");
const isArb = scriptName.includes("arb-engine");

// Validate env vars based on which engine is running
const baseRequired = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const solanaRequired = ["SOLANA_PRIVATE_KEY", "HELIUS_RPC_URL"];
const limitlessRequired = ["BASE_PRIVATE_KEY", "LIMITLESS_API_KEY"];

const required = [
  ...baseRequired,
  ...(isLimitless ? limitlessRequired : solanaRequired),
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

  // ── Solana (MEV + Jupiter Arb) ────────────────────────
  HELIUS_WS: process.env.HELIUS_RPC_URL || "",
  HELIUS_HTTP: process.env.HELIUS_HTTP_URL || (process.env.HELIUS_RPC_URL || "").replace(/^wss:\/\//, "https://"),
  PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || "",

  // ── MEV Engine ────────────────────────────────────────
  JITO_TIP: Number(process.env.JITO_TIP_LAMPORTS || 5_000_000),
  MIN_PROFIT: Number(process.env.MIN_PROFIT_USD || 0.05),
  WHALE_THRESHOLD: Number(process.env.WHALE_THRESHOLD_USD || 5_000),
  SOL_PRICE_USD: Number(process.env.SOL_PRICE_USD || 170),
  PARSED_TX_MIN_INTERVAL_MS: Number(process.env.PARSED_TX_MIN_INTERVAL_MS || 800),
  RATE_LIMIT_BACKOFF_MS: Number(process.env.RATE_LIMIT_BACKOFF_MS || 2_000),
  MAX_GET_TX_RETRIES: Number(process.env.MAX_GET_TX_RETRIES || 4),
  MAX_PENDING_SIGNATURES: Number(process.env.MAX_PENDING_SIGNATURES || 500),

  // ── Jupiter / DFlow Arb ───────────────────────────────
  ARB_AMOUNT: parseFloat(process.env.ARB_AMOUNT_USD || "25"),
  MIN_SPREAD: parseFloat(process.env.MIN_SPREAD || "0.001"),
  SCAN_INTERVAL: parseInt(process.env.SCAN_INTERVAL_MS || "10000"),

  DRIFT_DATA_API: process.env.DRIFT_DATA_API || "https://data.api.drift.trade",
  DRIFT_GATEWAY_URL: process.env.DRIFT_GATEWAY_URL || "http://localhost:8080",

  DFLOW_METADATA_API: process.env.DFLOW_METADATA_API || "https://prediction-markets-api.dflow.net",
  DFLOW_TRADE_API: process.env.DFLOW_TRADE_API || "https://quote-api.dflow.net",
  DFLOW_API_KEY: process.env.DFLOW_API_KEY || "",

  JUP_PREDICT_API: process.env.JUP_PREDICT_API || "https://prediction-market-api.jup.ag/api/v1",
  JUP_PREDICT_API_KEY: process.env.JUP_PREDICT_API_KEY || "",
  JUP_USD_MINT: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",

  // ── Limitless (Base Chain) ────────────────────────────
  LIMITLESS_API: process.env.LIMITLESS_API || "https://api.limitless.exchange",
  LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY || "",
  BASE_RPC_URL: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  BASE_PRIVATE_KEY: process.env.BASE_PRIVATE_KEY || "",
  LIMITLESS_MIN_SPREAD: parseFloat(process.env.LIMITLESS_MIN_SPREAD || "0.015"),
  LIMITLESS_TRADE_SIZE_USD: parseFloat(process.env.LIMITLESS_TRADE_SIZE_USD || "25"),
  LIMITLESS_SCAN_INTERVAL_MS: parseInt(process.env.LIMITLESS_SCAN_INTERVAL_MS || "8000"),

  // Gnosis CTF on Base (Limitless uses this for merge/split)
  CTF_ADDRESS: process.env.CTF_ADDRESS || "0x7Ffa3c445876EAC20215D109E42413e6a0b0D842",
  LIMITLESS_USDC: process.env.LIMITLESS_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;
