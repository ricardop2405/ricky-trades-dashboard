import "dotenv/config";

// Validate required env vars
const required = ["SOLANA_PRIVATE_KEY", "HELIUS_RPC_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const CONFIG = {
  // Solana
  HELIUS_WS: process.env.HELIUS_RPC_URL!,
  HELIUS_HTTP: process.env.HELIUS_HTTP_URL || process.env.HELIUS_RPC_URL!.replace(/^wss:\/\//, "https://"),
  PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY!,

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,

  // MEV
  JITO_TIP: Number(process.env.JITO_TIP_LAMPORTS || 5_000_000),
  MIN_PROFIT: Number(process.env.MIN_PROFIT_USD || 0.05),
  WHALE_THRESHOLD: Number(process.env.WHALE_THRESHOLD_USD || 5_000),
  SOL_PRICE_USD: Number(process.env.SOL_PRICE_USD || 170),
  PARSED_TX_MIN_INTERVAL_MS: Number(process.env.PARSED_TX_MIN_INTERVAL_MS || 800),
  RATE_LIMIT_BACKOFF_MS: Number(process.env.RATE_LIMIT_BACKOFF_MS || 2_000),
  MAX_GET_TX_RETRIES: Number(process.env.MAX_GET_TX_RETRIES || 4),
  MAX_PENDING_SIGNATURES: Number(process.env.MAX_PENDING_SIGNATURES || 500),

  // Arb — DFlow + Jupiter Predict
  ARB_AMOUNT: parseFloat(process.env.ARB_AMOUNT_USD || "25"),
  MIN_SPREAD: parseFloat(process.env.MIN_SPREAD || "0.001"),
  SCAN_INTERVAL: parseInt(process.env.SCAN_INTERVAL_MS || "10000"),

  // Drift BET (public Data API — no key needed)
  DRIFT_DATA_API: process.env.DRIFT_DATA_API || "https://data.api.drift.trade",
  DRIFT_GATEWAY_URL: process.env.DRIFT_GATEWAY_URL || "http://localhost:8080",

  // DFlow API (kept as fallback, requires production key)
  DFLOW_METADATA_API: process.env.DFLOW_METADATA_API || "https://prediction-markets-api.dflow.net",
  DFLOW_TRADE_API: process.env.DFLOW_TRADE_API || "https://quote-api.dflow.net",
  DFLOW_API_KEY: process.env.DFLOW_API_KEY || "",

  // Jupiter Predict API
  JUP_PREDICT_API: process.env.JUP_PREDICT_API || "https://prediction-market-api.jup.ag/api/v1",
  JUP_PREDICT_API_KEY: process.env.JUP_PREDICT_API_KEY || "",
  JUP_USD_MINT: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
} as const;