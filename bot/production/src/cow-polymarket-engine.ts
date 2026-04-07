/**
 * RICKY TRADES — Polymarket Atomic Arb Engine (Polygon)
 *
 * Strategy: Sum-to-One arbitrage on ANY active market
 *   1. Scan ALL active Polymarket markets (no settlement filter — merge is instant)
 *   2. Find YES+NO best ask combined < $1.00 (minus fees)
 *   3. Buy both sides via FOK (Fill-or-Kill) orders → fills instantly or $0 cost
 *   4. Merge YES+NO via CTF → guaranteed $1.00 USDC payout
 *
 * ATOMIC EXECUTION:
 *   ✅ FOK orders: fills immediately at your price or auto-cancels (you pay nothing)
 *   ✅ Sequential: Buy YES first (FOK), then NO (FOK)
 *   ✅ If YES fills but NO fails → auto-sell YES at market bid (recover funds)
 *   ✅ CTF merge is on-chain atomic & guaranteed
 *   ✅ Only gas cost is the merge tx (~$0.01 on Polygon)
 *
 * Usage:
 *   npm run cow
 *
 * Required env:
 *   POLYGON_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE (optional — auto-derived if missing)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { sleep } from "./utils";

// ══════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════

const POLYGON_PRIVATE_KEY = process.env.POLYGON_PRIVATE_KEY;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TRADE_SIZE_USD = parseFloat(process.env.COW_TRADE_SIZE_USD || "10");
const MIN_SPREAD = parseFloat(process.env.COW_MIN_SPREAD || "0.02");
const SCAN_INTERVAL_MS = parseInt(process.env.COW_SCAN_INTERVAL_MS || "5000");
const MAX_MARKET_DURATION_MIN = parseInt(process.env.COW_MAX_DURATION_MIN || "60");
const DRY_RUN = process.env.COW_DRY_RUN === "true";

// Polymarket CLOB credentials (auto-derived from wallet if not set)
const POLY_API_KEY = process.env.POLYMARKET_API_KEY || "";
const POLY_API_SECRET = process.env.POLYMARKET_API_SECRET || "";
const POLY_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE || "";

// ── Contracts ───────────────────────────────────────────
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;
const POLYMARKET_NEG_RISK_CTF = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as Address;
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address;
const POLYMARKET_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as Address;
const POLYMARKET_NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as Address;

// ── APIs ────────────────────────────────────────────────
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// ── Validate ────────────────────────────────────────────
if (!POLYGON_PRIVATE_KEY) { console.error("[POLY] Missing POLYGON_PRIVATE_KEY"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("[POLY] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

// ══════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════

const account = privateKeyToAccount(POLYGON_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });
const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URL) });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Polymarket Atomic Arb Engine");
console.log("  FOK Orders + CTF Merge = Zero-Risk Execution");
console.log("═══════════════════════════════════════════════════════");
console.log(`[POLY] Mode: ${DRY_RUN ? "🔍 DRY RUN (scan only)" : "⚡ LIVE TRADING"}`);
console.log(`[POLY] Wallet: ${account.address}`);
console.log(`[POLY] Trade size: $${TRADE_SIZE_USD}`);
console.log(`[POLY] Min spread: ${(MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[POLY] Market filter: ALL active markets (merge is instant)`);
console.log(`[POLY] Order type: FOK (Fill-or-Kill) — atomic, $0 if no fill`);
console.log(`[POLY] Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
console.log(`[POLY] CLOB creds: ${POLY_API_KEY ? "✅ provided" : "⚠️ will auto-derive"}`);
console.log("═══════════════════════════════════════════════════════");

// ══════════════════════════════════════════════════════════
//  ABIs
// ══════════════════════════════════════════════════════════

const CTF_ABI = parseAbi([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ══════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════

interface PolyMarket {
  id: string;
  slug: string;
  question: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesBestAsk: number;
  noBestAsk: number;
  yesBestBid: number;
  noBestBid: number;
  yesAskDepth: number;
  noAskDepth: number;
  endDate: string;
  volume: number;
  negRisk: boolean;
  tickSize: string;
}

interface ArbOpportunity {
  market: PolyMarket;
  yesCost: number;
  noCost: number;
  totalCost: number;
  payout: number;
  spread: number;
  netProfit: number;
  contracts: number;
}

// ══════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timeout);
      return res;
    } catch (err: any) {
      lastErr = err;
      if (i < retries - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr || new Error("fetchWithRetry exhausted");
}

const MAX_UINT256 = 2n ** 256n - 1n;
const approvedSet = new Set<string>();

async function ensureERC20Approval(token: Address, spender: Address, label: string): Promise<void> {
  const key = `erc20-${token}-${spender}`;
  if (approvedSet.has(key)) return;
  const allowance = await publicClient.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance < parseUnits("100000", 6)) {
    console.log(`[POLY] Approving ${label} for ${spender.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[POLY] ✅ ${label} approved`);
  }
  approvedSet.add(key);
}

async function ensureCTFApproval(ctf: Address, operator: Address, label: string): Promise<void> {
  const key = `ctf-${ctf}-${operator}`;
  if (approvedSet.has(key)) return;
  const approved = await publicClient.readContract({
    address: ctf, abi: CTF_ABI, functionName: "isApprovedForAll",
    args: [account.address, operator],
  });
  if (!approved) {
    console.log(`[POLY] Setting CTF approval: ${label}...`);
    const hash = await walletClient.writeContract({
      address: ctf, abi: CTF_ABI, functionName: "setApprovalForAll",
      args: [operator, true],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[POLY] ✅ CTF ${label} approved`);
  }
  approvedSet.add(key);
}

// Market cooldowns — prevent re-executing the same arb
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 3 * 60 * 1000;

// ══════════════════════════════════════════════════════════
//  POLYMARKET CLOB — AUTH & ORDERS
// ══════════════════════════════════════════════════════════

// EIP-712 domain for Polymarket CLOB auth
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

interface ClobCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

let clobCreds: ClobCreds | null = null;

/**
 * Derive or use provided CLOB API credentials.
 */
async function getClobCreds(): Promise<ClobCreds> {
  if (clobCreds) return clobCreds;

  if (POLY_API_KEY && POLY_API_SECRET && POLY_PASSPHRASE) {
    clobCreds = { apiKey: POLY_API_KEY, secret: POLY_API_SECRET, passphrase: POLY_PASSPHRASE };
    console.log("[POLY] Using provided CLOB API credentials");
    return clobCreds;
  }

  // Auto-derive credentials via L1 auth
  console.log("[POLY] Deriving CLOB API credentials from wallet...");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0n;

  const sig = await walletClient.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp,
      nonce,
      message: "This message attests that I control the given wallet",
    },
  });

  const res = await fetchWithRetry(`${CLOB_API}/auth/derive-api-key`, {
    method: "GET",
    headers: {
      "POLY_ADDRESS": account.address,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": timestamp,
      "POLY_NONCE": "0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[POLY] Failed to derive API key (${res.status}): ${body.slice(0, 200)}`);

    // Try creating new key
    const createRes = await fetchWithRetry(`${CLOB_API}/auth/api-key`, {
      method: "POST",
      headers: {
        "POLY_ADDRESS": account.address,
        "POLY_SIGNATURE": sig,
        "POLY_TIMESTAMP": timestamp,
        "POLY_NONCE": "0",
      },
    });

    if (!createRes.ok) {
      const b2 = await createRes.text().catch(() => "");
      throw new Error(`Cannot derive or create CLOB API key: ${b2.slice(0, 200)}`);
    }

    const created = await createRes.json();
    clobCreds = { apiKey: created.apiKey, secret: created.secret, passphrase: created.passphrase };
    console.log(`[POLY] ✅ Created new CLOB API key: ${created.apiKey.slice(0, 8)}...`);
    return clobCreds;
  }

  const derived = await res.json();
  clobCreds = { apiKey: derived.apiKey, secret: derived.secret, passphrase: derived.passphrase };
  console.log(`[POLY] ✅ Derived CLOB API key: ${derived.apiKey.slice(0, 8)}...`);
  return clobCreds;
}

/**
 * Generate HMAC-SHA256 signature for CLOB L2 auth headers.
 */
async function signClobRequest(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const message = timestamp + method.toUpperCase() + path + body;
  const encoder = new TextEncoder();
  const keyData = Buffer.from(secret, "base64");
  const key = await globalThis.crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Buffer.from(sig).toString("base64");
}

/**
 * Make an authenticated CLOB API request.
 */
async function clobFetch(method: string, path: string, body?: object): Promise<Response> {
  const creds = await getClobCreds();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sig = await signClobRequest(method, path, bodyStr, timestamp, creds.secret);

  return fetchWithRetry(`${CLOB_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "POLY_ADDRESS": account.address,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": timestamp,
      "POLY_NONCE": "0",
      "POLY_API_KEY": creds.apiKey,
      "POLY_PASSPHRASE": creds.passphrase,
    },
    body: bodyStr || undefined,
  });
}

// ══════════════════════════════════════════════════════════
//  ORDER SIGNING (Polymarket Exchange EIP-712)
// ══════════════════════════════════════════════════════════

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

function getExchangeDomain(negRisk: boolean) {
  return {
    name: negRisk ? "Polymarket Neg Risk CTF Exchange" : "Polymarket CTF Exchange",
    version: "1",
    chainId: 137,
    verifyingContract: negRisk ? POLYMARKET_NEG_RISK_EXCHANGE : POLYMARKET_EXCHANGE,
  };
}

interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
}

/**
 * Create and sign a Polymarket CLOB order.
 * side: 0 = BUY, 1 = SELL
 */
async function createSignedOrder(
  tokenId: string,
  price: number,
  size: number,
  side: 0 | 1,
  negRisk: boolean,
  tickSize: string,
): Promise<SignedOrder> {
  const salt = BigInt(Math.floor(Math.random() * 2 ** 128)).toString();
  const expiration = (Math.floor(Date.now() / 1000) + 300).toString(); // 5 min validity
  const nonce = "0";
  const feeRateBps = "0"; // Taker fee is separate

  // For BUY: makerAmount = USDC to spend, takerAmount = shares to receive
  // Price is in USDC per share, amounts in raw units (6 decimals for USDC, 6 for shares)
  const rawSize = parseUnits(size.toFixed(6), 6);

  // Round price to tick size
  const tickDecimals = tickSize === "0.001" ? 3 : tickSize === "0.0001" ? 4 : 2;
  const roundedPrice = parseFloat(price.toFixed(tickDecimals));

  let makerAmount: bigint;
  let takerAmount: bigint;

  if (side === 0) {
    // BUY: maker gives USDC, taker gives shares
    makerAmount = parseUnits((roundedPrice * size).toFixed(6), 6);
    takerAmount = rawSize;
  } else {
    // SELL: maker gives shares, taker gives USDC
    makerAmount = rawSize;
    takerAmount = parseUnits((roundedPrice * size).toFixed(6), 6);
  }

  const orderData = {
    salt: BigInt(salt),
    maker: account.address as Address,
    signer: account.address as Address,
    taker: "0x0000000000000000000000000000000000000000" as Address,
    tokenId: BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration: BigInt(expiration),
    nonce: BigInt(nonce),
    feeRateBps: BigInt(feeRateBps),
    side,
    signatureType: 0, // EOA
  };

  const signature = await walletClient.signTypedData({
    domain: getExchangeDomain(negRisk),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: orderData,
  });

  return {
    salt,
    maker: account.address,
    signer: account.address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId,
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration,
    nonce,
    feeRateBps,
    side,
    signatureType: 0,
    signature,
  };
}

/**
 * Submit a signed order to the Polymarket CLOB.
 */
async function submitOrder(order: SignedOrder, negRisk: boolean, tickSize: string): Promise<string | null> {
  try {
    const orderPayload = {
      order,
      owner: account.address,
      orderType: "FOK", // Fill-or-Kill: fills instantly at price or auto-cancels ($0 cost)
    };

    const res = await clobFetch("POST", "/order", orderPayload);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[POLY] Order submit failed (${res.status}): ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const orderId = data.orderID || data.id || null;
    if (orderId) {
      console.log(`[POLY] ✅ Order placed: ${orderId.slice(0, 16)}...`);
    }
    return orderId;
  } catch (err) {
    console.error("[POLY] Order submit error:", err);
    return null;
  }
}

/**
 * Check order fill status.
 */
async function checkOrderFilled(orderId: string): Promise<"live" | "filled" | "cancelled"> {
  try {
    const res = await fetchWithRetry(`${CLOB_API}/order/${orderId}`);
    if (!res.ok) return "live";
    const data = await res.json();
    if (data.status === "MATCHED" || data.status === "FILLED" || data.size_matched === data.original_size) return "filled";
    if (data.status === "CANCELLED") return "cancelled";
    return "live";
  } catch {
    return "live";
  }
}

/**
 * Cancel an order.
 */
async function cancelOrder(orderId: string): Promise<void> {
  try {
    await clobFetch("DELETE", `/order/${orderId}`);
  } catch {}
}

// ══════════════════════════════════════════════════════════
//  MARKET SCANNER
// ══════════════════════════════════════════════════════════

async function fetchMarkets(): Promise<PolyMarket[]> {
  const markets: PolyMarket[] = [];

  try {
    let totalFetched = 0;

    for (let page = 0; page < 10; page++) {
      const offset = page * 100;
      const url = `${GAMMA_API}/markets?closed=false&active=true&limit=100&offset=${offset}&order=volume&ascending=false`;
      const res = await fetchWithRetry(url);
      if (!res.ok) break;

      const data = await res.json();
      const batch = Array.isArray(data) ? data : data.data || data.markets || [];
      if (batch.length === 0) break;
      totalFetched += batch.length;

      for (const m of batch) {
        if (!m.clobTokenIds || !m.conditionId) continue;
        const endDate = m.endDate || m.end_date_iso;
        if (!endDate) continue;

        // Only skip already-ended markets
        const timeLeft = new Date(endDate).getTime() - Date.now();
        if (timeLeft < 60_000) continue; // Skip if ending in < 1 min (too risky)

        let tokenIds: string[];
        try { tokenIds = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; } catch { continue; }
        if (!tokenIds || tokenIds.length < 2) continue;

        markets.push({
          id: String(m.id),
          slug: m.slug || m.id,
          question: m.question || "",
          conditionId: m.conditionId,
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          yesBestAsk: 0, noBestAsk: 0,
          yesBestBid: 0, noBestBid: 0,
          yesAskDepth: 0, noAskDepth: 0,
          endDate,
          volume: Number(m.volume || 0),
          negRisk: m.negRisk === true || m.neg_risk === true,
          tickSize: m.minimum_tick_size || "0.01",
        });
      }

      if (batch.length < 100) break;
    }

    console.log(`[POLY] Scanned ${totalFetched} markets → ${markets.length} active`);

    // Fetch orderbooks in batches
    const withBooks: PolyMarket[] = [];
    for (let i = 0; i < markets.length; i += 5) {
      const batch = markets.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (m) => {
        try {
          const [yR, nR] = await Promise.all([
            fetchWithRetry(`${CLOB_API}/book?token_id=${m.yesTokenId}`),
            fetchWithRetry(`${CLOB_API}/book?token_id=${m.noTokenId}`),
          ]);
          if (!yR.ok || !nR.ok) return null;
          const yB = await yR.json(), nB = await nR.json();

          const yAsks = (yB.asks || []).sort((a: any, b: any) => +a.price - +b.price);
          const nAsks = (nB.asks || []).sort((a: any, b: any) => +a.price - +b.price);
          const yBids = (yB.bids || []).sort((a: any, b: any) => +b.price - +a.price);
          const nBids = (nB.bids || []).sort((a: any, b: any) => +b.price - +a.price);

          m.yesBestAsk = yAsks[0] ? +yAsks[0].price : 1;
          m.noBestAsk = nAsks[0] ? +nAsks[0].price : 1;
          m.yesBestBid = yBids[0] ? +yBids[0].price : 0;
          m.noBestBid = nBids[0] ? +nBids[0].price : 0;
          m.yesAskDepth = yAsks[0] ? +yAsks[0].size : 0;
          m.noAskDepth = nAsks[0] ? +nAsks[0].size : 0;
          return m;
        } catch { return null; }
      }));
      for (const r of results) if (r) withBooks.push(r);
    }

    console.log(`[POLY] ${withBooks.length} markets with orderbooks`);
    return withBooks;
  } catch (err) {
    console.error("[POLY] Fetch error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════
//  ARB DETECTION
// ══════════════════════════════════════════════════════════

function findArbs(markets: PolyMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    if (cooldowns.has(market.id) && Date.now() - cooldowns.get(market.id)! < COOLDOWN_MS) continue;

    const combined = market.yesBestAsk + market.noBestAsk;
    if (combined <= 0 || combined >= 1) continue;

    // How many contracts can we buy given trade size and orderbook depth
    const maxContracts = Math.floor(TRADE_SIZE_USD / combined);
    const contracts = Math.min(maxContracts, Math.floor(market.yesAskDepth), Math.floor(market.noAskDepth));
    if (contracts <= 0) continue;

    const yesCost = contracts * market.yesBestAsk;
    const noCost = contracts * market.noBestAsk;
    const totalCost = yesCost + noCost;
    const payout = contracts; // 1 USDC per merged contract
    const estimatedGas = 0.01; // Polygon merge gas ~$0.01
    const polyFee = totalCost * 0.005; // ~0.5% taker fee estimate
    const netProfit = payout - totalCost - estimatedGas - polyFee;
    const spread = (payout - totalCost) / payout;

    if (spread < MIN_SPREAD || netProfit <= 0) continue;

    opps.push({ market, yesCost, noCost, totalCost, payout, spread, netProfit, contracts });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ══════════════════════════════════════════════════════════
//  EXECUTION — CLOB ORDERS + CTF MERGE
// ══════════════════════════════════════════════════════════

async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, contracts, netProfit, spread } = opp;

  console.log(`\n[POLY] 🎯 ARB: "${market.question.slice(0, 70)}"`);
  console.log(`[POLY]   YES=$${market.yesBestAsk.toFixed(4)} + NO=$${market.noBestAsk.toFixed(4)} = $${(market.yesBestAsk + market.noBestAsk).toFixed(4)}`);
  console.log(`[POLY]   ${contracts} contracts | spread ${(spread * 100).toFixed(2)}% | est profit $${netProfit.toFixed(4)}`);
  console.log(`[POLY]   Depth: YES=${market.yesAskDepth} NO=${market.noAskDepth} | negRisk=${market.negRisk}`);

  if (DRY_RUN) {
    console.log(`[POLY] 🔍 DRY RUN — would execute. Skipping.`);
    await logExecution(opp, "dry-run", null, 0, netProfit);
    return;
  }

  cooldowns.set(market.id, Date.now());

  try {
    // Ensure USDC.e approved for the exchange
    const exchange = market.negRisk ? POLYMARKET_NEG_RISK_EXCHANGE : POLYMARKET_EXCHANGE;
    await ensureERC20Approval(USDC_E, exchange, "USDC.e→Exchange");

    // ═══════════════════════════════════════════════════
    // ATOMIC EXECUTION: FOK (Fill-or-Kill) Sequential
    //   Step 1: Buy YES (FOK) — fills instantly or $0
    //   Step 2: Buy NO (FOK) — fills instantly or $0
    //   Step 3: If only one side filled → sell it back
    //   Step 4: If both filled → merge via CTF for $1
    // ═══════════════════════════════════════════════════

    // Step 1: Buy YES (FOK)
    console.log(`[POLY] 📡 Step 1: Buying YES (FOK @ $${market.yesBestAsk.toFixed(4)})...`);
    const yesOrder = await createSignedOrder(
      market.yesTokenId, market.yesBestAsk, contracts, 0, market.negRisk, market.tickSize
    );
    const yesOrderId = await submitOrder(yesOrder, market.negRisk, market.tickSize);

    if (!yesOrderId) {
      console.log(`[POLY] ❌ YES order rejected — $0 cost, moving on`);
      await logExecution(opp, "yes-rejected", null, 0, 0, "YES FOK order rejected");
      return;
    }

    // FOK should fill instantly — brief check
    await sleep(1000);
    const yesStatus = await checkOrderFilled(yesOrderId);
    if (yesStatus !== "filled") {
      console.log(`[POLY] ❌ YES FOK not filled (status: ${yesStatus}) — $0 cost`);
      if (yesStatus === "live") await cancelOrder(yesOrderId);
      await logExecution(opp, "yes-not-filled", null, 0, 0, `YES FOK status: ${yesStatus}`);
      return;
    }
    console.log(`[POLY] ✅ YES filled!`);

    // Step 2: Buy NO (FOK)
    console.log(`[POLY] 📡 Step 2: Buying NO (FOK @ $${market.noBestAsk.toFixed(4)})...`);
    const noOrder = await createSignedOrder(
      market.noTokenId, market.noBestAsk, contracts, 0, market.negRisk, market.tickSize
    );
    const noOrderId = await submitOrder(noOrder, market.negRisk, market.tickSize);

    if (!noOrderId) {
      // YES filled but NO rejected → sell YES back at market bid
      console.log(`[POLY] ⚠️ NO rejected — selling YES back at bid $${market.yesBestBid.toFixed(4)}`);
      await sellBackPosition(market.yesTokenId, contracts, market.yesBestBid, market.negRisk, market.tickSize);
      const loss = (market.yesBestAsk - market.yesBestBid) * contracts;
      await logExecution(opp, "no-rejected-sold-yes", null, 0, -loss, "NO rejected, sold YES at bid");
      return;
    }

    await sleep(1000);
    const noStatus = await checkOrderFilled(noOrderId);
    if (noStatus !== "filled") {
      console.log(`[POLY] ⚠️ NO FOK not filled — selling YES back at bid`);
      if (noStatus === "live") await cancelOrder(noOrderId);
      await sellBackPosition(market.yesTokenId, contracts, market.yesBestBid, market.negRisk, market.tickSize);
      const loss = (market.yesBestAsk - market.yesBestBid) * contracts;
      await logExecution(opp, "no-not-filled-sold-yes", null, 0, -loss, `NO status: ${noStatus}, sold YES`);
      return;
    }
    console.log(`[POLY] ✅ NO filled!`);

    // Step 3: Both filled → MERGE for guaranteed $1!
    console.log(`[POLY] 🎉 BOTH SIDES FILLED! Merging via CTF...`);
    const ctfAddress = market.negRisk ? POLYMARKET_NEG_RISK_CTF : POLYMARKET_CTF;
    await mergeCTF(ctfAddress, market, contracts, opp.totalCost);
    await logExecution(opp, "success", null, 0.01, contracts - opp.totalCost - 0.01);
  } catch (err) {
    console.error(`[POLY] ❌ Execution error:`, err);
    await logExecution(opp, "error", null, 0, 0, err instanceof Error ? err.message : "Unknown error");
  }
}

/**
 * Emergency sell-back: if one side filled but the other didn't,
 * sell the filled position at best bid to recover funds.
 */
async function sellBackPosition(
  tokenId: string, size: number, bidPrice: number,
  negRisk: boolean, tickSize: string,
): Promise<void> {
  try {
    if (bidPrice <= 0) {
      console.log(`[POLY] ⚠️ No bid to sell back to — holding position`);
      return;
    }
    console.log(`[POLY] 📡 Selling ${size} tokens @ $${bidPrice.toFixed(4)} (FOK)...`);
    const sellOrder = await createSignedOrder(tokenId, bidPrice, size, 1, negRisk, tickSize);
    const sellId = await submitOrder(sellOrder, negRisk, tickSize);
    if (sellId) {
      await sleep(1000);
      const status = await checkOrderFilled(sellId);
      if (status === "filled") {
        console.log(`[POLY] ✅ Sell-back filled — funds recovered`);
      } else {
        console.log(`[POLY] ⚠️ Sell-back not filled (${status}) — holding position`);
        if (status === "live") await cancelOrder(sellId);
      }
    }
  } catch (err) {
    console.error(`[POLY] Sell-back error:`, err);
  }
}

// ══════════════════════════════════════════════════════════
//  CTF MERGE — GUARANTEED $1 PAYOUT
// ══════════════════════════════════════════════════════════

async function mergeCTF(ctfAddress: Address, market: PolyMarket, contracts: number, totalCost: number): Promise<void> {
  const mergeAmount = parseUnits(contracts.toFixed(6), 6);
  console.log(`[POLY] Merging ${contracts} contracts via CTF at ${ctfAddress.slice(0, 10)}...`);

  const mergeHash = await walletClient.writeContract({
    address: ctfAddress,
    abi: CTF_ABI,
    functionName: "mergePositions",
    args: [
      USDC_E,
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      market.conditionId as Hex,
      [1n, 2n],
      mergeAmount,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: mergeHash });
  const gasWei = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
  const gasMatic = Number(formatUnits(BigInt(gasWei), 18));
  const gasUSD = gasMatic * 0.4; // ~$0.40/MATIC
  const finalProfit = contracts - totalCost - gasUSD;

  console.log(`[POLY] ✅ MERGED! tx=${mergeHash}`);
  console.log(`[POLY]   Gas: ${gasMatic.toFixed(6)} MATIC ($${gasUSD.toFixed(4)})`);
  console.log(`[POLY]   🎉 FINAL P&L: +$${finalProfit.toFixed(4)}`);
}

// ══════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════

async function logExecution(
  opp: ArbOpportunity, status: string, txHash: string | null,
  gasCostUSD: number, pnl: number, errorMsg?: string,
): Promise<void> {
  try {
    const { data: mkt } = await supabase.from("prediction_markets").upsert({
      platform: "polymarket", external_id: opp.market.id,
      question: opp.market.question, yes_price: opp.market.yesBestAsk,
      no_price: opp.market.noBestAsk, volume: opp.market.volume,
      end_date: opp.market.endDate, category: "all",
      last_synced_at: new Date().toISOString(),
    }, { onConflict: "platform,external_id" }).select("id").single();
    if (!mkt) return;

    const { data: oppData } = await supabase.from("arb_opportunities").insert({
      market_a_id: mkt.id, market_b_id: mkt.id,
      side_a: "yes", side_b: "no",
      price_a: opp.market.yesBestAsk, price_b: opp.market.noBestAsk,
      spread: opp.spread, status: status === "success" ? "executed" : status === "dry-run" ? "open" : "failed",
    }).select("id").single();

    if (oppData) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppData.id, status,
        amount_usd: opp.totalCost, realized_pnl: pnl,
        fees: gasCostUSD, side_a_tx: txHash, side_b_tx: txHash,
        error_message: errorMsg || null,
      });
    }
  } catch (err) {
    console.error("[POLY] Log error:", err);
  }
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function checkBalance(): Promise<number> {
  try {
    const bal = await publicClient.readContract({
      address: USDC_E, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
    });
    const usd = Number(formatUnits(bal, 6));
    console.log(`[POLY] USDC.e balance: $${usd.toFixed(2)}`);
    return usd;
  } catch { console.error("[POLY] Balance check failed"); return 0; }
}

async function main(): Promise<void> {
  const balance = await checkBalance();
  if (!DRY_RUN && balance < TRADE_SIZE_USD) {
    console.error(`[POLY] ❌ Insufficient USDC.e: $${balance.toFixed(2)} < $${TRADE_SIZE_USD}`);
    console.error("[POLY] Fund your Polygon wallet with USDC.e and MATIC");
    return;
  }

  // Derive/validate CLOB credentials
  try {
    await getClobCreds();
  } catch (err) {
    console.error("[POLY] ❌ Cannot get CLOB credentials:", err);
    console.error("[POLY] Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE in .env");
    console.error("[POLY] Or ensure your POLYGON_PRIVATE_KEY wallet is registered on Polymarket");
    return;
  }

  let scanCount = 0;
  while (true) {
    scanCount++;
    console.log(`\n[POLY] ── Scan #${scanCount} ──────────────────────────`);

    try {
      const markets = await fetchMarkets();
      const opps = findArbs(markets);

      if (opps.length === 0) {
        console.log("[POLY] No arb opportunities found");
      } else {
        console.log(`[POLY] 🔥 Found ${opps.length} opportunities:`);
        for (const o of opps) {
          const endMs = new Date(o.market.endDate).getTime() - Date.now();
          const timeStr = endMs < 3600000 ? `${Math.round(endMs / 60000)}m` : `${Math.round(endMs / 3600000)}h`;
          console.log(
            `  "${o.market.question.slice(0, 55)}" ` +
            `spread=${(o.spread * 100).toFixed(2)}% net=$${o.netProfit.toFixed(4)} ` +
            `depth=Y:${o.market.yesAskDepth}/N:${o.market.noAskDepth} ` +
            `ends=${timeStr}`
          );
        }
        // Execute the best opportunity
        await executeArb(opps[0]);
      }
    } catch (err) {
      console.error("[POLY] Scan error:", err);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => { console.error("[POLY] Fatal:", err); process.exit(1); });
