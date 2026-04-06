import "dotenv/config";

// ── Only Limitless (Base Chain) env vars required ───────
const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BASE_PRIVATE_KEY",
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

  // ── Limitless (Base Chain) ────────────────────────────
  LIMITLESS_API: process.env.LIMITLESS_API || "https://api.limitless.exchange",
  LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY || "",
  BASE_RPC_URL: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  BASE_PRIVATE_KEY: process.env.BASE_PRIVATE_KEY || "",
  LIMITLESS_MIN_SPREAD: parseFloat(process.env.LIMITLESS_MIN_SPREAD || "0.015"),
  LIMITLESS_TRADE_SIZE_USD: parseFloat(process.env.LIMITLESS_TRADE_SIZE_USD || "5"),
  LIMITLESS_SCAN_INTERVAL_MS: parseInt(process.env.LIMITLESS_SCAN_INTERVAL_MS || "8000"),

  // Gnosis CTF on Base
  CTF_ADDRESS: process.env.CTF_ADDRESS || "0x7Ffa3c445876EAC20215D109E42413e6a0b0D842",
  LIMITLESS_USDC: process.env.LIMITLESS_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;
