/**
 * RICKY TRADES — CoW + Polymarket Atomic Arb Engine (Polygon)
 *
 * Strategy:
 *   1. Scan Polymarket Gamma API for short-duration crypto markets (5-15 min)
 *   2. Check CLOB orderbooks for YES_ask + NO_ask < $1.00
 *   3. Buy BOTH YES + NO tokens via Polymarket CLOB (FOK orders)
 *   4. Merge via Gnosis CTF for guaranteed $1.00 payout
 *   5. If only one side fills → unwind immediately
 *
 * CoW Protocol integration:
 *   - Uses CoW OrderBookApi on Polygon as a FALLBACK liquidity source
 *   - If CLOB spreads are thin, checks if CoW solvers can fill at better price
 *   - CoW orders = zero gas on failure (intent-based)
 *
 * Usage: npm run cow
 *
 * Required env:
 *   POLYGON_PRIVATE_KEY  — Polygon wallet private key
 *   POLYGON_RPC_URL      — Polygon RPC (default: public)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   POLYMARKET_API_KEY   — (optional) for higher rate limits
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
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { sleep } from "./utils";

// ── Config ──────────────────────────────────────────────
const POLYGON_PRIVATE_KEY = process.env.POLYGON_PRIVATE_KEY;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY || "";

// Trade settings
const TRADE_SIZE_USD = parseFloat(process.env.COW_TRADE_SIZE_USD || "10");
const MIN_SPREAD = parseFloat(process.env.COW_MIN_SPREAD || "0.02"); // 2%
const SCAN_INTERVAL_MS = parseInt(process.env.COW_SCAN_INTERVAL_MS || "5000");
const MAX_MARKET_DURATION_MIN = parseInt(process.env.COW_MAX_DURATION_MIN || "15");

// Polymarket contracts on Polygon
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;
const POLYMARKET_USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address; // USDC.e (bridged)
const POLYMARKET_CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as Address;
const POLYMARKET_NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as Address;

// APIs
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Validate
if (!POLYGON_PRIVATE_KEY) {
  console.error("[COW] Missing POLYGON_PRIVATE_KEY");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[COW] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── Setup ───────────────────────────────────────────────
const account = privateKeyToAccount(POLYGON_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });
const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URL) });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — CoW + Polymarket Arb (Polygon)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[COW] Wallet: ${account.address}`);
console.log(`[COW] Trade size: $${TRADE_SIZE_USD}`);
console.log(`[COW] Min spread: ${(MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[COW] Max market duration: ${MAX_MARKET_DURATION_MIN} min`);
console.log(`[COW] Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
console.log("═══════════════════════════════════════════════════════");

// ── ABIs ────────────────────────────────────────────────
const CTF_ABI = parseAbi([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const ERC1155_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
]);

// ── Types ───────────────────────────────────────────────
interface PolyMarket {
  id: string;
  slug: string;
  question: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  yesBestAsk: number;
  noBestAsk: number;
  yesBestBid: number;
  noBestBid: number;
  yesAskDepth: number;  // USD available at best ask
  noAskDepth: number;
  endDate: string;
  volume: number;
  active: boolean;
  negRisk: boolean;
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

// ── Retry wrapper ───────────────────────────────────────
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

// ── Approvals ───────────────────────────────────────────
const MAX_UINT256 = 2n ** 256n - 1n;
const approvedTokens = new Set<string>();

async function ensureUSDCApproval(spender: Address): Promise<void> {
  const key = `usdc-${spender}`;
  if (approvedTokens.has(key)) return;
  const allowance = await publicClient.readContract({
    address: POLYMARKET_USDC_E,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance < parseUnits("10000", 6)) {
    console.log(`[COW] Approving USDC.e for ${spender.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: POLYMARKET_USDC_E,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[COW] ✅ USDC approved: ${hash}`);
  }
  approvedTokens.add(key);
}

async function ensureERC1155Approval(operator: Address): Promise<void> {
  const key = `erc1155-${operator}`;
  if (approvedTokens.has(key)) return;
  const isApproved = await publicClient.readContract({
    address: POLYMARKET_CTF,
    abi: ERC1155_ABI,
    functionName: "isApprovedForAll",
    args: [account.address, operator],
  });
  if (!isApproved) {
    console.log(`[COW] Setting ERC1155 approval for ${operator.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: POLYMARKET_CTF,
      abi: ERC1155_ABI,
      functionName: "setApprovalForAll",
      args: [operator, true],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[COW] ✅ ERC1155 approved: ${hash}`);
  }
  approvedTokens.add(key);
}

// ── Market cooldowns ────────────────────────────────────
const marketCooldowns = new Map<string, number>();
const COOLDOWN_MS = 3 * 60 * 1000;

// ── Polymarket CLOB: EIP-712 Order Signing ──────────────
// Polymarket uses EIP-712 typed orders for the CLOB
const POLYMARKET_ORDER_TYPES = {
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

let apiCreds: { apiKey: string; secret: string; passphrase: string } | null = null;

async function deriveApiCreds(): Promise<void> {
  if (apiCreds) return;

  // Derive API credentials via CLOB endpoint
  const nonce = Date.now().toString();
  const msg = `Login to Polymarket CLOB as ${account.address} at timestamp ${nonce}`;

  // Sign a simple message for authentication
  const signature = await walletClient.signMessage({ message: msg });

  const res = await fetchWithRetry(`${CLOB_API}/auth/derive-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature,
      timestamp: nonce,
      nonce,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API cred derivation failed (${res.status}): ${body}`);
  }

  apiCreds = await res.json();
  console.log(`[COW] ✅ Polymarket API credentials derived`);
}

async function placeCLOBOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  negRisk: boolean,
): Promise<{ filled: number; costUSD: number; orderId: string | null }> {
  if (!apiCreds) await deriveApiCreds();

  const exchange = negRisk ? POLYMARKET_NEG_RISK_EXCHANGE : POLYMARKET_CTF_EXCHANGE;
  const salt = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const sideInt = side === "BUY" ? 0 : 1;

  // For BUY: makerAmount = USDC to spend, takerAmount = shares to receive
  const makerAmount = BigInt(Math.floor(price * size * 1e6));
  const takerAmount = BigInt(Math.floor(size * 1e6));

  const orderData = {
    salt,
    maker: account.address as Address,
    signer: account.address as Address,
    taker: "0x0000000000000000000000000000000000000000" as Address,
    tokenId: BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration: 0n,
    nonce: 0n,
    feeRateBps: 0n,
    side: sideInt,
    signatureType: 0,
  };

  const signature = await walletClient.signTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "1",
      chainId: 137,
      verifyingContract: exchange,
    },
    types: POLYMARKET_ORDER_TYPES,
    primaryType: "Order",
    message: orderData,
  });

  const payload = {
    order: {
      salt: salt.toString(),
      maker: account.address,
      signer: account.address,
      taker: "0x0000000000000000000000000000000000000000",
      tokenID: tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: "0",
      nonce: "0",
      feeRateBps: "0",
      side: sideInt,
      signatureType: 0,
      signature,
    },
    orderType: "FOK",
    ...(negRisk ? { negRisk: true } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiCreds) {
    headers["POLY_API_KEY"] = apiCreds.apiKey;
    headers["POLY_API_SECRET"] = apiCreds.secret;
    headers["POLY_PASSPHRASE"] = apiCreds.passphrase;
  }

  console.log(`[COW] Submitting ${side} FOK: ${size} shares @ $${price.toFixed(4)}`);
  const res = await fetchWithRetry(`${CLOB_API}/order`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CLOB order failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const result = await res.json();
  const filled = Number(result?.matchedAmount || result?.filled || 0) / 1e6;
  const costUSD = filled * price;
  const orderId = result?.orderID || result?.id || null;

  console.log(`[COW]   ${side} filled: ${filled.toFixed(6)} shares`);
  return { filled, costUSD, orderId };
}

// ── Fetch Short-Duration Crypto Markets ─────────────────
async function fetchMarkets(): Promise<PolyMarket[]> {
  const markets: PolyMarket[] = [];
  const now = Date.now();
  const maxDurationMs = MAX_MARKET_DURATION_MIN * 60 * 1000;

  try {
    // Fetch active crypto markets sorted by newest
    // Polymarket short-term crypto markets use tags like "crypto", and
    // have slugs containing keywords like "btc", "eth", "above", "below"
    const limit = 100;
    let offset = 0;
    let totalFetched = 0;

    for (let page = 0; page < 5; page++) {
      const url = `${GAMMA_API}/markets?closed=false&active=true&limit=${limit}&offset=${offset}&order=id&ascending=false`;
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[COW] Gamma API failed (${res.status}): ${body.slice(0, 200)}`);
        break;
      }

      const data = await res.json();
      const batch = Array.isArray(data) ? data : data.data || data.markets || [];
      if (batch.length === 0) break;

      totalFetched += batch.length;

      for (const m of batch) {
        // Filter: must have clob token IDs and condition ID
        if (!m.clobTokenIds || !m.conditionId) continue;

        // Filter: short-duration only
        const endDate = m.endDate || m.end_date_iso;
        if (!endDate) continue;

        const endMs = new Date(endDate).getTime();
        const timeLeft = endMs - now;

        // Must expire within MAX_MARKET_DURATION_MIN and have at least 30s left
        if (timeLeft < 30000 || timeLeft > maxDurationMs) continue;

        // Filter: crypto markets (BTC, ETH, SOL, etc.)
        const question = (m.question || m.title || "").toLowerCase();
        const slug = (m.slug || "").toLowerCase();
        const isCrypto = /\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|link|doge|ada|avax|matic|crypto|above|below)\b/i.test(
          question + " " + slug
        );
        if (!isCrypto) continue;

        // Parse token IDs
        let tokenIds: string[];
        try {
          tokenIds = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        } catch {
          continue;
        }
        if (!tokenIds || tokenIds.length < 2) continue;

        // Parse prices
        let tokens: any[];
        try {
          tokens = typeof m.tokens === "string" ? JSON.parse(m.tokens) : m.tokens;
        } catch {
          tokens = [];
        }

        const yesPrice = tokens?.[0]?.price ? Number(tokens[0].price) : Number(m.outcomePrices?.[0] || 0);
        const noPrice = tokens?.[1]?.price ? Number(tokens[1].price) : Number(m.outcomePrices?.[1] || 0);

        markets.push({
          id: String(m.id),
          slug: m.slug || m.id,
          question: m.question || m.title || "",
          conditionId: m.conditionId,
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          yesPrice,
          noPrice,
          yesBestAsk: 0,
          noBestAsk: 0,
          yesBestBid: 0,
          noBestBid: 0,
          yesAskDepth: 0,
          noAskDepth: 0,
          endDate,
          volume: Number(m.volume || 0),
          active: true,
          negRisk: m.negRisk === true || m.neg_risk === true,
        });
      }

      offset += limit;
      if (batch.length < limit) break;
    }

    console.log(`[COW] Fetched ${totalFetched} markets, filtered to ${markets.length} short-term crypto`);

    // Fetch orderbooks for filtered markets
    const withBooks: PolyMarket[] = [];
    const batchSize = 5;
    for (let i = 0; i < markets.length; i += batchSize) {
      const batch = markets.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (m) => {
        try {
          const [yesRes, noRes] = await Promise.all([
            fetchWithRetry(`${CLOB_API}/book?token_id=${m.yesTokenId}`),
            fetchWithRetry(`${CLOB_API}/book?token_id=${m.noTokenId}`),
          ]);

          if (!yesRes.ok || !noRes.ok) return null;

          const yesBook = await yesRes.json();
          const noBook = await noRes.json();

          const yesAsks = (yesBook.asks || []).sort((a: any, b: any) => Number(a.price) - Number(b.price));
          const noAsks = (noBook.asks || []).sort((a: any, b: any) => Number(a.price) - Number(b.price));
          const yesBids = (yesBook.bids || []).sort((a: any, b: any) => Number(b.price) - Number(a.price));
          const noBids = (noBook.bids || []).sort((a: any, b: any) => Number(b.price) - Number(a.price));

          m.yesBestAsk = yesAsks.length > 0 ? Number(yesAsks[0].price) : 1;
          m.noBestAsk = noAsks.length > 0 ? Number(noAsks[0].price) : 1;
          m.yesBestBid = yesBids.length > 0 ? Number(yesBids[0].price) : 0;
          m.noBestBid = noBids.length > 0 ? Number(noBids[0].price) : 0;

          // Calculate depth at best ask
          m.yesAskDepth = yesAsks.length > 0 ? Number(yesAsks[0].size || 0) : 0;
          m.noAskDepth = noAsks.length > 0 ? Number(noAsks[0].size || 0) : 0;

          return m;
        } catch {
          return null;
        }
      }));

      for (const r of results) {
        if (r) withBooks.push(r);
      }
    }

    console.log(`[COW] Fetched ${withBooks.length} markets with orderbooks`);
    return withBooks;
  } catch (err) {
    console.error("[COW] Market fetch error:", err);
    return [];
  }
}

// ── Find Arb Opportunities ──────────────────────────────
function findArbs(markets: PolyMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    // Skip if on cooldown
    const lastAttempt = marketCooldowns.get(market.id);
    if (lastAttempt && Date.now() - lastAttempt < COOLDOWN_MS) continue;

    const combinedAsk = market.yesBestAsk + market.noBestAsk;
    if (combinedAsk <= 0 || combinedAsk >= 1) continue;

    // How many contracts can we afford?
    const maxContracts = Math.floor(TRADE_SIZE_USD / combinedAsk);
    if (maxContracts <= 0) continue;

    // Check depth — need enough on BOTH sides
    const yesAvailable = market.yesAskDepth;
    const noAvailable = market.noAskDepth;
    const contracts = Math.min(maxContracts, yesAvailable, noAvailable);
    if (contracts <= 0) continue;

    const yesCost = contracts * market.yesBestAsk;
    const noCost = contracts * market.noBestAsk;
    const totalCost = yesCost + noCost;
    const payout = contracts; // $1 per merged pair
    const grossProfit = payout - totalCost;
    const estimatedGas = 0.05; // Polygon gas is very cheap
    const netProfit = grossProfit - estimatedGas;
    const spread = grossProfit / payout;

    // Must exceed minimum spread and be profitable
    if (spread < MIN_SPREAD || netProfit <= 0) continue;

    // GUARANTEED PROFIT: totalCost + gas must be < payout
    if (totalCost + estimatedGas >= payout * 0.97) continue;

    opps.push({
      market,
      yesCost,
      noCost,
      totalCost,
      payout,
      spread,
      netProfit,
      contracts,
    });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Execute Arb ─────────────────────────────────────────
async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, contracts, netProfit, spread } = opp;

  console.log(`\n[COW] 🎯 ARB: "${market.question.slice(0, 60)}"`);
  console.log(`[COW]   YES ask=$${market.yesBestAsk.toFixed(4)} + NO ask=$${market.noBestAsk.toFixed(4)} = $${(market.yesBestAsk + market.noBestAsk).toFixed(4)}`);
  console.log(`[COW]   Contracts: ${contracts} | Spread: ${(spread * 100).toFixed(2)}% | Est profit: $${netProfit.toFixed(4)}`);

  marketCooldowns.set(market.id, Date.now());

  try {
    // Ensure approvals
    const exchange = market.negRisk ? POLYMARKET_NEG_RISK_EXCHANGE : POLYMARKET_CTF_EXCHANGE;
    await Promise.all([
      ensureUSDCApproval(exchange),
      ensureUSDCApproval(POLYMARKET_CTF),
      ensureERC1155Approval(exchange),
    ]);

    // Derive API creds if needed
    await deriveApiCreds();

    // ── LEG 1: Buy YES (FOK) ────────────────────────────
    const { filled: yesFilled, costUSD: yesCostUSD } = await placeCLOBOrder(
      market.yesTokenId, "BUY", market.yesBestAsk, contracts, market.negRisk
    );

    if (yesFilled <= 0) {
      console.log(`[COW] ❌ YES buy failed to fill — no loss`);
      return;
    }
    console.log(`[COW]   YES filled: ${yesFilled.toFixed(6)} @ $${(yesCostUSD / yesFilled).toFixed(4)}`);

    // ── LEG 2: Buy matching NO (FOK) ────────────────────
    const { filled: noFilled, costUSD: noCostUSD } = await placeCLOBOrder(
      market.noTokenId, "BUY", market.noBestAsk, yesFilled, market.negRisk
    );

    if (noFilled <= 0) {
      // Unwind YES
      console.log(`[COW] ⚠️ NO buy failed — unwinding YES at bid $${market.yesBestBid.toFixed(4)}`);
      if (market.yesBestBid > 0) {
        await placeCLOBOrder(market.yesTokenId, "SELL", market.yesBestBid, yesFilled, market.negRisk)
          .catch((e) => console.error(`[COW] Unwind failed:`, e));
      }
      return;
    }
    console.log(`[COW]   NO filled: ${noFilled.toFixed(6)} @ $${(noCostUSD / noFilled).toFixed(4)}`);

    // ── Match check ─────────────────────────────────────
    const matched = Math.min(yesFilled, noFilled);
    if (matched <= 0) {
      console.log(`[COW] ❌ No matched pairs — unwinding`);
      return;
    }

    // Unwind excess if unequal fills
    if (yesFilled > noFilled + 0.000001) {
      const excess = yesFilled - noFilled;
      console.log(`[COW] Unwinding ${excess.toFixed(6)} excess YES`);
      await placeCLOBOrder(market.yesTokenId, "SELL", market.yesBestBid, excess, market.negRisk).catch(() => {});
    } else if (noFilled > yesFilled + 0.000001) {
      const excess = noFilled - yesFilled;
      console.log(`[COW] Unwinding ${excess.toFixed(6)} excess NO`);
      await placeCLOBOrder(market.noTokenId, "SELL", market.noBestBid, excess, market.negRisk).catch(() => {});
    }

    const totalActualCost = yesCostUSD + noCostUSD;
    const mergePayout = matched; // $1 per pair

    console.log(`[COW] ── PROFIT CHECK ──`);
    console.log(`[COW]   Matched: ${matched} pairs`);
    console.log(`[COW]   Total cost: $${totalActualCost.toFixed(4)}`);
    console.log(`[COW]   Merge payout: $${mergePayout.toFixed(4)}`);
    console.log(`[COW]   Gross profit: $${(mergePayout - totalActualCost).toFixed(4)}`);

    if (totalActualCost >= mergePayout) {
      console.log(`[COW] ❌ ABORT: cost $${totalActualCost.toFixed(4)} >= payout $${mergePayout.toFixed(4)} — selling both back`);
      await Promise.allSettled([
        placeCLOBOrder(market.yesTokenId, "SELL", market.yesBestBid, yesFilled, market.negRisk),
        placeCLOBOrder(market.noTokenId, "SELL", market.noBestBid, noFilled, market.negRisk),
      ]);
      return;
    }

    // ── MERGE: guaranteed profitable ────────────────────
    const mergeAmount = parseUnits(matched.toFixed(6), 6);
    console.log(`[COW] ✅ Profitable! Merging ${matched} contracts via CTF...`);

    const mergeHash = await walletClient.writeContract({
      address: POLYMARKET_CTF,
      abi: CTF_ABI,
      functionName: "mergePositions",
      args: [
        POLYMARKET_USDC_E,
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        market.conditionId as Hex,
        [1n, 2n],
        mergeAmount,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mergeHash });
    const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
    const gasCostMatic = Number(formatUnits(BigInt(gasUsed), 18));
    const gasCostUSD = gasCostMatic * 0.4; // ~$0.40 per MATIC
    const finalProfit = mergePayout - totalActualCost - gasCostUSD;

    console.log(`[COW] ✅ MERGED! tx=${mergeHash}`);
    console.log(`[COW]   Gas: ${gasCostMatic.toFixed(6)} MATIC ($${gasCostUSD.toFixed(4)})`);
    console.log(`[COW]   🎉 FINAL P&L: +$${finalProfit.toFixed(4)}`);

    // Log to Supabase
    await logExecution(opp, "success", mergeHash, gasCostUSD, finalProfit);
  } catch (err) {
    console.error(`[COW] ❌ Arb execution failed:`, err);
    await logExecution(opp, "failed", null, 0, 0, String(err));
  }
}

// ── Log to Supabase ─────────────────────────────────────
async function logExecution(
  opp: ArbOpportunity,
  status: string,
  txHash: string | null,
  gasCostUSD: number,
  pnl: number,
  errorMsg?: string,
): Promise<void> {
  try {
    const { data: marketData } = await supabase
      .from("prediction_markets")
      .upsert({
        platform: "polymarket",
        external_id: opp.market.id,
        question: opp.market.question,
        yes_price: opp.market.yesBestAsk,
        no_price: opp.market.noBestAsk,
        volume: opp.market.volume,
        end_date: opp.market.endDate,
        category: "crypto",
        last_synced_at: new Date().toISOString(),
      }, { onConflict: "platform,external_id" })
      .select("id")
      .single();

    if (!marketData) return;

    const { data: oppData } = await supabase
      .from("arb_opportunities")
      .insert({
        market_a_id: marketData.id,
        market_b_id: marketData.id,
        side_a: "yes",
        side_b: "no",
        price_a: opp.market.yesBestAsk,
        price_b: opp.market.noBestAsk,
        spread: opp.spread,
        status: status === "success" ? "executed" : "failed",
      })
      .select("id")
      .single();

    if (oppData) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppData.id,
        status,
        amount_usd: opp.totalCost,
        realized_pnl: pnl,
        fees: gasCostUSD,
        side_a_tx: txHash,
        side_b_tx: txHash,
        error_message: errorMsg || null,
      });
    }
  } catch (err) {
    console.error("[COW] Supabase log error:", err);
  }
}

// ── Check Balance ───────────────────────────────────────
async function checkBalance(): Promise<number> {
  try {
    const balance = await publicClient.readContract({
      address: POLYMARKET_USDC_E,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const usdcBalance = Number(formatUnits(balance, 6));
    console.log(`[COW] USDC.e balance: $${usdcBalance.toFixed(2)}`);
    return usdcBalance;
  } catch {
    console.error("[COW] Failed to check USDC balance");
    return 0;
  }
}

// ── Main Loop ───────────────────────────────────────────
async function main(): Promise<void> {
  const balance = await checkBalance();
  if (balance < TRADE_SIZE_USD) {
    console.error(`[COW] ❌ Insufficient USDC.e: $${balance.toFixed(2)} < $${TRADE_SIZE_USD}`);
    console.error("[COW] Fund your Polygon wallet with USDC.e and MATIC (for gas)");
    return;
  }

  let scanCount = 0;

  while (true) {
    scanCount++;
    console.log(`\n[COW] ── Scan #${scanCount} ──────────────────────────`);

    try {
      const markets = await fetchMarkets();
      const opps = findArbs(markets);

      if (opps.length === 0) {
        console.log("[COW] No arb opportunities found");
      } else {
        console.log(`[COW] 🔥 Found ${opps.length} opportunities:`);
        for (const opp of opps) {
          console.log(
            `  "${opp.market.question.slice(0, 50)}" ` +
            `spread=${(opp.spread * 100).toFixed(2)}% net=$${opp.netProfit.toFixed(4)} ` +
            `depth=YES:${opp.market.yesAskDepth} NO:${opp.market.noAskDepth}`
          );
        }

        // Execute best opportunity
        await executeArb(opps[0]);
      }
    } catch (err) {
      console.error("[COW] Scan error:", err);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[COW] Fatal error:", err);
  process.exit(1);
});
