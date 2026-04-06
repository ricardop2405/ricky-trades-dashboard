/**
 * RICKY TRADES — Limitless Intra-Platform Arb Engine (Base Chain)
 *
 * Strategy: On Limitless prediction markets, when YES_ask + NO_ask < $1,
 * buy BOTH YES and NO shares, then merge them via Gnosis CTF for $1.
 * When YES_bid + NO_bid > $1, split $1 into YES+NO via CTF, sell both.
 *
 * Orders are placed via the Limitless CLOB using EIP-712 signed orders.
 *
 * Usage: npm run limitless
 */

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
import { base } from "viem/chains";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Retry wrapper for network resilience ────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (err: any) {
      lastError = err;
      const code = err?.cause?.code || err?.code || "";
      if (code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "ECONNRESET" || err.name === "AbortError") {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`[LIM] ⚠️ Fetch retry ${attempt + 1}/${maxRetries} (${code}) — waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err; // non-retryable error
    }
  }
  throw lastError || new Error("fetchWithRetry exhausted");
}

// ── Setup ───────────────────────────────────────────────
const account = privateKeyToAccount(CONFIG.BASE_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: base, transport: http(CONFIG.BASE_RPC_URL) });
const walletClient = createWalletClient({ account, chain: base, transport: http(CONFIG.BASE_RPC_URL) });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — Limitless Intra-Platform Arb (Base)");
console.log("═══════════════════════════════════════════════════════");
console.log(`[LIM] Wallet: ${account.address}`);
console.log(`[LIM] Trade size: $${CONFIG.LIMITLESS_TRADE_SIZE_USD}`);
console.log(`[LIM] Min spread: ${(CONFIG.LIMITLESS_MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[LIM] Scan interval: ${CONFIG.LIMITLESS_SCAN_INTERVAL_MS / 1000}s`);
console.log(`[LIM] CTF: ${CONFIG.CTF_ADDRESS}`);
console.log("═══════════════════════════════════════════════════════");

// ── Gnosis CTF ABI (merge/split) ────────────────────────
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

// ── EIP-712 Types for Limitless Orders ──────────────────
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

// ── Types ───────────────────────────────────────────────
interface OrderbookLevel {
  price: number;
  size: number;
}

interface LimitlessMarket {
  slug: string;
  title: string;
  status: string;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  yesAsks: OrderbookLevel[];
  yesBids: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  noBids: OrderbookLevel[];
  conditionId: string;
  collateralToken: Address;
  expiresAt: string | null;
  category: string | null;
  volume: number;
  yesTokenId: string;
  noTokenId: string;
  venueExchange: Address;
}

interface ArbOpportunity {
  market: LimitlessMarket;
  direction: "merge" | "split";
  yesPrice: number;
  noPrice: number;
  totalCost: number;
  payout: number;
  spread: number;
  grossProfit: number;
  estimatedGas: number;
  netProfit: number;
}

// Market cooldown — avoid retrying same market
const marketCooldowns = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;
let orderNonce = 0;
let cachedFeeRateBps: number | null = null;
const ENABLE_SPLIT_ARBS = false;

function normalizeBookSide(levels: any[], descending = false): OrderbookLevel[] {
  return (Array.isArray(levels) ? levels : [])
    .map((level: any) => ({
      price: Number(level?.price ?? 0),
      size: Number(level?.size ?? level?.amount ?? level?.quantity ?? level?.shares ?? 0),
    }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function getDepthFill(levels: OrderbookLevel[], targetContracts: number): { avgPrice: number; totalCost: number } | null {
  if (targetContracts <= 0) return null;
  let remaining = targetContracts;
  let totalCost = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    totalCost += take * level.price;
    remaining -= take;
  }

  if (remaining > 1e-9) return null;
  return { avgPrice: totalCost / targetContracts, totalCost };
}

function getExecutionContracts(result: any): number {
  const raw = result?.execution?.totalsRaw ?? result?.execution?.totals ?? {};
  const net = Number(raw.contractsNet ?? 0);
  const gross = Number(raw.contractsGross ?? 0);
  const filled = net || gross;
  return filled > 0 ? filled / 1e6 : 0;
}

function getExecutionCostUSD(result: any, fallbackContracts: number, fallbackPrice: number): number {
  const raw = result?.execution?.totalsRaw ?? result?.execution?.totals ?? {};
  // Try every possible field the API might return for cost
  const candidates = [
    raw.makerAmountNet, raw.makerAmountGross, raw.totalCost,
    raw.collateralAmount, raw.cost, raw.amount,
  ];
  for (const c of candidates) {
    const v = Number(c ?? 0);
    if (v > 0) return v / 1e6;
  }
  // ALWAYS fall back to filled contracts × price — never return 0
  const filled = getExecutionContracts(result);
  const contracts = filled > 0 ? filled : fallbackContracts;
  const cost = contracts * fallbackPrice;
  console.log(`[LIM] ⚠️ Cost fallback used: ${contracts.toFixed(6)} × $${fallbackPrice.toFixed(4)} = $${cost.toFixed(4)}`);
  return cost;
}

// ── Sign & Submit an EIP-712 Order ──────────────────────
async function placeSignedOrder(
  market: LimitlessMarket,
  side: 0 | 1, // 0=BUY, 1=SELL
  tokenId: string,
  price: number,
  size: number,
  orderType: "FOK" | "GTC" = "FOK",
): Promise<any> {
  if (!CONFIG.LIMITLESS_OWNER_ID) throw new Error("Missing LIMITLESS_OWNER_ID in .env");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["X-API-Key"] = CONFIG.LIMITLESS_API_KEY;

  // Use cached fee rate or fetch it once
  if (cachedFeeRateBps === null) {
    try {
      const feeRes = await fetchWithRetry(`${CONFIG.LIMITLESS_API}/profiles/${account.address}`, { headers });
      if (feeRes.ok) {
        const feeData = await feeRes.json();
        cachedFeeRateBps = Number(feeData?.rank?.feeRateBps ?? feeData?.feeRateBps ?? 0);
        console.log(`[LIM] Fee rate for account: ${cachedFeeRateBps} bps`);
      } else {
        cachedFeeRateBps = 0;
        console.log(`[LIM] Fee profile lookup failed: ${feeRes.status}, using 0`);
      }
    } catch {
      cachedFeeRateBps = 0;
      console.log(`[LIM] Could not fetch fee profile, using 0`);
    }
  }
  const feeRateBps = cachedFeeRateBps;

  const salt = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  orderNonce++;

  // Amount calculations per Limitless docs
  let makerAmount: bigint;
  let takerAmount: bigint;

  if (orderType === "FOK") {
    // FOK: takerAmount always = 1
    if (side === 0) {
      // BUY FOK: makerAmount = USDC to spend
      makerAmount = BigInt(Math.floor(price * size * 1e6));
    } else {
      // SELL FOK: keep makerAmount under available balance after fees
      const safeSize = feeRateBps > 0 ? size / (1 + feeRateBps / 10000) : size;
      makerAmount = BigInt(Math.floor(safeSize * 1e6));
    }
    takerAmount = 1n;
  } else {
    // GTC limit orders
    if (side === 0) {
      // BUY: maker gives USDC, receives shares
      makerAmount = BigInt(Math.floor(price * size * 1e6));
      takerAmount = BigInt(Math.floor(size * 1e6));
    } else {
      // SELL: maker gives shares, receives USDC
      makerAmount = BigInt(Math.floor(size * 1e6));
      takerAmount = BigInt(Math.floor(price * size * 1e6));
    }
  }

  const orderData = {
    salt,
    maker: account.address as Address,
    signer: account.address as Address,
    taker: "0x0000000000000000000000000000000000000000" as Address,
    tokenId: BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration: 0n, // no expiration
    nonce: 0n,
    feeRateBps: BigInt(feeRateBps),
    side,
    signatureType: 0, // EOA
  };

  // Sign the order with EIP-712
  const signature = await walletClient.signTypedData({
    domain: {
      name: "Limitless CTF Exchange",
      version: "1",
      chainId: 8453,
      verifyingContract: market.venueExchange,
    },
    types: ORDER_TYPES,
    primaryType: "Order",
    message: orderData,
  });

  // Build the API payload
  const payload = {
    order: {
      salt: Number(salt),
      maker: account.address,
      signer: account.address,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId,
      makerAmount: Number(makerAmount),
      takerAmount: Number(takerAmount),
      expiration: "0",
      nonce: 0,
      feeRateBps: feeRateBps,
      side,
      signatureType: 0,
      signature,
      ...(orderType === "GTC" ? { price } : {}),
    },
    ownerId: CONFIG.LIMITLESS_OWNER_ID,
    orderType,
    marketSlug: market.slug,
  };

  const sideLabel = side === 0 ? "BUY" : "SELL";
  console.log(`[LIM] Submitting ${sideLabel} ${orderType} order: tokenId=${tokenId.slice(0, 12)}... maker=${Number(makerAmount)} taker=${Number(takerAmount)} ownerId=${CONFIG.LIMITLESS_OWNER_ID}`);

  const res = await fetchWithRetry(`${CONFIG.LIMITLESS_API}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Order failed (${res.status}): ${err}`);
  }

  const result = await res.json();
  console.log(`[LIM] ✅ ${sideLabel} order accepted: matched=${result.execution?.matched}`);
  return result;
}

// ── Fetch Limitless Orderbooks ──────────────────────────
async function fetchMarkets(): Promise<LimitlessMarket[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["x-api-key"] = CONFIG.LIMITLESS_API_KEY;

  try {
    const res = await fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/active?limit=25`, { headers });
    if (!res.ok) {
      console.error(`[LIM] Markets fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const rawMarkets = Array.isArray(data) ? data : data.data || data.markets || [];
    const markets: LimitlessMarket[] = [];

    const batchSize = 10;
    for (let i = 0; i < rawMarkets.length; i += batchSize) {
      const batch = rawMarkets.slice(i, i + batchSize);
      const bookPromises = batch.map(async (m: any) => {
        try {
          const slug = m.slug || m.id;
          const yesTokenId = m.tokens?.yes;
          const noTokenId = m.tokens?.no;
          const venueExchange = m.venue?.exchange;
          if (!slug || !yesTokenId || !noTokenId || !venueExchange) return null;

          const [yesBookRes, noBookRes] = await Promise.all([
            fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${yesTokenId}`, { headers }),
            fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${noTokenId}`, { headers }),
          ]);

          if (!yesBookRes.ok || !noBookRes.ok) return null;

          const yesBook = await yesBookRes.json();
          const noBook = await noBookRes.json();
          const yesAsks = normalizeBookSide(yesBook.asks || [], false);
          const yesBids = normalizeBookSide(yesBook.bids || [], true);
          const noAsks = normalizeBookSide(noBook.asks || [], false);
          const noBids = normalizeBookSide(noBook.bids || [], true);

          return {
            slug,
            title: m.title || m.question || slug,
            status: m.status || "active",
            yesAsk: yesAsks.length > 0 ? yesAsks[0].price : 1,
            yesBid: yesBids.length > 0 ? yesBids[0].price : 0,
            noAsk: noAsks.length > 0 ? noAsks[0].price : 1,
            noBid: noBids.length > 0 ? noBids[0].price : 0,
            yesAsks,
            yesBids,
            noAsks,
            noBids,
            conditionId: m.conditionId || "",
            collateralToken: (m.collateralToken?.address || CONFIG.LIMITLESS_USDC) as Address,
            expiresAt: m.expirationDate || m.expiresAt || null,
            category: Array.isArray(m.categories) ? m.categories[0] || null : m.category || null,
            volume: Number(m.volume || 0),
            yesTokenId,
            noTokenId,
            venueExchange: venueExchange as Address,
          } as LimitlessMarket;
        } catch {
          return null;
        }
      });

      const results = await Promise.all(bookPromises);
      for (const m of results) {
        if (m && m.conditionId) markets.push(m);
      }
    }

    console.log(`[LIM] Fetched ${markets.length} markets with orderbooks`);
    return markets;
  } catch (err) {
    console.error("[LIM] Fetch error:", err);
    return [];
  }
}

// ── Find Arb Opportunities ──────────────────────────────
function findArbs(markets: LimitlessMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];
  const contracts = Math.floor(CONFIG.LIMITLESS_TRADE_SIZE_USD);
  const feeMultiplier = 1 + (cachedFeeRateBps ?? 0) / 10000; // e.g. 1.03 for 300 bps

  for (const market of markets) {
    const lastAttempt = marketCooldowns.get(market.slug);
    if (lastAttempt && Date.now() - lastAttempt < COOLDOWN_MS) continue;

    const yesAskFill = getDepthFill(market.yesAsks, contracts);
    const noAskFill = getDepthFill(market.noAsks, contracts);

    if (yesAskFill && noAskFill) {
      // Total cost INCLUDING exchange fees on both buy legs
      const totalCost = (yesAskFill.totalCost + noAskFill.totalCost) * feeMultiplier;
      const payout = contracts; // merge gives $1 per contract
      const grossProfit = payout - totalCost;
      const spread = payout > 0 ? grossProfit / payout : 0;
      const estimatedGas = 0.15; // be conservative on gas
      const netProfit = grossProfit - estimatedGas;

      // HARD RULE: combined price per contract MUST be < $1 (investment < payout)
      const combinedPricePerContract = totalCost / contracts;
      if (combinedPricePerContract >= 0.97) {
        // Skip: too close to $1, no guaranteed profit after fees/gas
        continue;
      }

      if (spread > CONFIG.LIMITLESS_MIN_SPREAD && netProfit > 0) {
        opps.push({
          market,
          direction: 'merge',
          yesPrice: yesAskFill.avgPrice,
          noPrice: noAskFill.avgPrice,
          totalCost,
          payout,
          spread,
          grossProfit,
          estimatedGas,
          netProfit,
        });
      }
    }

    if (ENABLE_SPLIT_ARBS) {
      const yesBidFill = getDepthFill(market.yesBids, contracts);
      const noBidFill = getDepthFill(market.noBids, contracts);

      if (yesBidFill && noBidFill) {
        const payout = yesBidFill.totalCost + noBidFill.totalCost;
        const totalCost = contracts;
        const grossProfit = payout - totalCost;
        const spread = totalCost > 0 ? grossProfit / totalCost : 0;
        const estimatedGas = 0.10;
        const netProfit = grossProfit - estimatedGas;

        if (spread > CONFIG.LIMITLESS_MIN_SPREAD && netProfit > 0) {
          opps.push({
            market,
            direction: 'split',
            yesPrice: yesBidFill.avgPrice,
            noPrice: noBidFill.avgPrice,
            totalCost,
            payout,
            spread,
            grossProfit,
            estimatedGas,
            netProfit,
          });
        }
      }
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Ensure ERC20 Approval (max uint256 for gas savings) ─
const MAX_UINT256 = 2n ** 256n - 1n;
const approvedSpenders = new Set<string>();

async function ensureApproval(token: Address, spender: Address): Promise<void> {
  const key = `${token}-${spender}`;
  if (approvedSpenders.has(key)) return; // already approved this session

  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  });

  // If allowance is less than $10k worth, set to max
  if (allowance < parseUnits("10000", 6)) {
    console.log(`[LIM] Approving ${spender.slice(0, 10)}... for max USDC...`);
    const hash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[LIM] ✅ Approved: ${hash}`);
  }
  approvedSpenders.add(key);
}

// ── Execute Merge Arb ───────────────────────────────────
async function executeMergeArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesPrice, noPrice, netProfit } = opp;
  const tradeSize = CONFIG.LIMITLESS_TRADE_SIZE_USD;

  console.log(`\n[LIM] 🎯 MERGE ARB: "${market.title.slice(0, 50)}"`);
  console.log(`[LIM]   YES ask=$${yesPrice.toFixed(4)} + NO ask=$${noPrice.toFixed(4)} = $${(yesPrice + noPrice).toFixed(4)}`);
  console.log(`[LIM]   Spread: ${(opp.spread * 100).toFixed(2)}% | Net profit: $${netProfit.toFixed(4)}`);

  marketCooldowns.set(market.slug, Date.now());

  try {
    const contracts = Math.floor(tradeSize);

    // ── Approve USDC for exchange + CTF ────────────────
    await Promise.all([
      ensureApproval(market.collateralToken, market.venueExchange),
      ensureApproval(market.collateralToken, CONFIG.CTF_ADDRESS as Address),
    ]);

    // ── LEG 1: Buy YES ────────────────────────────────
    console.log(`[LIM] Buying YES: target ${contracts} contracts @ avg $${yesPrice.toFixed(4)}`);
    const yesResult = await placeSignedOrder(market, 0, market.yesTokenId, yesPrice, contracts, "FOK");
    if (!yesResult?.execution?.matched) {
      throw new Error("YES buy was not matched — aborting");
    }
    const yesFilled = getExecutionContracts(yesResult);
    const yesCostUSD = getExecutionCostUSD(yesResult, contracts, yesPrice);
    if (yesFilled <= 0) {
      throw new Error("YES buy returned 0 filled contracts");
    }
    console.log(`[LIM]   YES filled: ${yesFilled.toFixed(6)} contracts, cost: $${yesCostUSD.toFixed(4)}`);

    // ── LEG 2: Buy NO (match YES fill exactly) ──────
    console.log(`[LIM] Buying NO to match: ${yesFilled.toFixed(6)} contracts @ avg $${noPrice.toFixed(4)}`);
    const noResult = await placeSignedOrder(market, 0, market.noTokenId, noPrice, yesFilled, "FOK");
    if (!noResult?.execution?.matched) {
      // YES is unhedged — immediately sell it back
      console.log(`[LIM] ⚠️ NO not matched — selling YES back to unwind`);
      const unwindPrice = market.yesBid > 0 ? market.yesBid : yesPrice * 0.95;
      await placeSignedOrder(market, 1, market.yesTokenId, unwindPrice, yesFilled, "FOK");
      throw new Error("NO buy not matched — unwound YES position");
    }
    const noFilled = getExecutionContracts(noResult);
    const noCostUSD = getExecutionCostUSD(noResult, yesFilled, noPrice);
    if (noFilled <= 0) {
      console.log(`[LIM] ⚠️ NO fill=0 — selling YES back`);
      const unwindPrice = market.yesBid > 0 ? market.yesBid : yesPrice * 0.95;
      await placeSignedOrder(market, 1, market.yesTokenId, unwindPrice, yesFilled, "FOK");
      throw new Error("NO buy returned 0 filled — unwound YES");
    }
    console.log(`[LIM]   NO filled: ${noFilled.toFixed(6)} contracts, cost: $${noCostUSD.toFixed(4)}`);

    // ── SAFETY CHECK: verify profit before merging ──
    const matchedContracts = Math.min(yesFilled, noFilled);
    const totalActualCost = yesCostUSD + noCostUSD;
    const mergePayout = matchedContracts; // $1 per contract
    const estimatedGasCost = 0.15;
    const actualProfit = mergePayout - totalActualCost - estimatedGasCost;

    console.log(`[LIM] ── PROFIT CHECK ──`);
    console.log(`[LIM]   Matched: ${matchedContracts.toFixed(6)} contracts`);
    console.log(`[LIM]   Total cost: $${totalActualCost.toFixed(4)} (YES: $${yesCostUSD.toFixed(4)} + NO: $${noCostUSD.toFixed(4)})`);
    console.log(`[LIM]   Merge payout: $${mergePayout.toFixed(4)}`);
    console.log(`[LIM]   Est. profit after gas: $${actualProfit.toFixed(4)}`);

    if (totalActualCost >= mergePayout) {
      // NOT PROFITABLE — sell both sides back instead of merging
      console.log(`[LIM] ❌ ABORT: cost $${totalActualCost.toFixed(4)} >= payout $${mergePayout.toFixed(4)} — selling both back`);
      const yesBidPrice = market.yesBid > 0 ? market.yesBid : yesPrice * 0.95;
      const noBidPrice = market.noBid > 0 ? market.noBid : noPrice * 0.95;
      await Promise.all([
        placeSignedOrder(market, 1, market.yesTokenId, yesBidPrice, yesFilled, "FOK"),
        placeSignedOrder(market, 1, market.noTokenId, noBidPrice, noFilled, "FOK"),
      ]);
      throw new Error(`Aborted: actual cost $${totalActualCost.toFixed(4)} >= merge payout $${mergePayout.toFixed(4)}`);
    }

    // ── MERGE: guaranteed profitable ────────────────
    const mergeAmount = parseUnits(matchedContracts.toFixed(6), 6);
    console.log(`[LIM] ✅ Profitable! Merging ${matchedContracts.toFixed(6)} contracts...`);
    const mergeHash = await walletClient.writeContract({
      address: CONFIG.CTF_ADDRESS as Address,
      abi: CTF_ABI,
      functionName: "mergePositions",
      args: [
        market.collateralToken,
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        market.conditionId as Hex,
        [1n, 2n],
        mergeAmount,
      ],
    });

    // Sell any leftover unmatched contracts
    const leftoverYes = Math.max(0, yesFilled - matchedContracts);
    const leftoverNo = Math.max(0, noFilled - matchedContracts);
    if (leftoverYes > 0.00001) {
      const p = market.yesBid > 0 ? market.yesBid : yesPrice * 0.95;
      console.log(`[LIM] Selling leftover YES: ${leftoverYes.toFixed(6)} @ $${p.toFixed(4)}`);
      await placeSignedOrder(market, 1, market.yesTokenId, p, leftoverYes, "FOK");
    }
    if (leftoverNo > 0.00001) {
      const p = market.noBid > 0 ? market.noBid : noPrice * 0.95;
      console.log(`[LIM] Selling leftover NO: ${leftoverNo.toFixed(6)} @ $${p.toFixed(4)}`);
      await placeSignedOrder(market, 1, market.noTokenId, p, leftoverNo, "FOK");
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mergeHash });
    const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
    const gasCostEth = Number(formatUnits(BigInt(gasUsed), 18));
    const finalProfit = mergePayout - totalActualCost - (gasCostEth * 2500);

    console.log(`[LIM] ✅ MERGED! tx=${mergeHash}`);
    console.log(`[LIM]   Gas: ${gasCostEth.toFixed(6)} ETH ($${(gasCostEth * 2500).toFixed(4)})`);
    console.log(`[LIM]   FINAL P&L: +$${finalProfit.toFixed(4)}`);

    await logExecution(opp, "success", mergeHash, gasCostEth);
  } catch (err) {
    console.error(`[LIM] ❌ Merge arb failed:`, err);
    await logExecution(opp, "failed", null, 0, String(err));
  }
}

// ── Execute Split Arb ───────────────────────────────────
async function executeSplitArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesPrice, noPrice, netProfit } = opp;
  const tradeSize = CONFIG.LIMITLESS_TRADE_SIZE_USD;

  console.log(`\n[LIM] 🎯 SPLIT ARB: "${market.title.slice(0, 50)}"`);
  console.log(`[LIM]   YES bid=$${yesPrice.toFixed(4)} + NO bid=$${noPrice.toFixed(4)} = $${(yesPrice + noPrice).toFixed(4)}`);
  console.log(`[LIM]   Spread: ${(opp.spread * 100).toFixed(2)}% | Net profit: $${netProfit.toFixed(4)}`);

  marketCooldowns.set(market.slug, Date.now());

  try {
    const contracts = Math.floor(tradeSize);
    const splitAmount = parseUnits(String(contracts), 6);

    // Step 1: Approve USDC for CTF
    await ensureApproval(market.collateralToken, CONFIG.CTF_ADDRESS as Address);

    // Step 2: Split USDC into YES + NO via CTF
    console.log("[LIM] Splitting USDC into YES + NO via CTF...");
    const splitHash = await walletClient.writeContract({
      address: CONFIG.CTF_ADDRESS as Address,
      abi: CTF_ABI,
      functionName: "splitPosition",
      args: [
        market.collateralToken,
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        market.conditionId as Hex,
        [1n, 2n],
        splitAmount,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: splitHash });
    console.log(`[LIM] ✅ Split complete: ${splitHash}`);

    // Step 3: Approve shares for the venue exchange
    // CTF shares are ERC1155, venue may need approval
    // (Limitless handles this via the signed order flow)

    // Step 4: Sell YES via signed order
    console.log(`[LIM] Selling YES: ${contracts} @ $${yesPrice.toFixed(4)}`);
    await placeSignedOrder(market, 1, market.yesTokenId, yesPrice, contracts, "FOK");

    // Step 5: Sell NO via signed order
    console.log(`[LIM] Selling NO: ${contracts} @ $${noPrice.toFixed(4)}`);
    await placeSignedOrder(market, 1, market.noTokenId, noPrice, contracts, "FOK");

    const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
    const gasCostEth = Number(formatUnits(BigInt(gasUsed), 18));
    console.log(`[LIM] ✅ SPLIT ARB COMPLETE | Net profit: ~$${netProfit.toFixed(4)}`);

    await logExecution(opp, "success", splitHash, gasCostEth);
  } catch (err) {
    console.error(`[LIM] ❌ Split arb failed:`, err);
    await logExecution(opp, "failed", null, 0, String(err));
  }
}

// ── Log to Supabase ─────────────────────────────────────
async function logExecution(
  opp: ArbOpportunity,
  status: string,
  txHash: string | null,
  gasCostEth: number,
  errorMsg?: string,
): Promise<void> {
  try {
    const { data: marketData } = await supabase
      .from("prediction_markets")
      .upsert({
        platform: "limitless",
        external_id: opp.market.slug,
        question: opp.market.title,
        yes_price: opp.yesPrice,
        no_price: opp.noPrice,
        volume: opp.market.volume,
        end_date: opp.market.expiresAt,
        category: opp.market.category,
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
        price_a: opp.yesPrice,
        price_b: opp.noPrice,
        spread: opp.spread,
        status: status === "success" ? "executed" : "failed",
      })
      .select("id")
      .single();

    if (oppData) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppData.id,
        status,
        amount_usd: CONFIG.LIMITLESS_TRADE_SIZE_USD,
        realized_pnl: status === "success" ? opp.netProfit : 0,
        fees: gasCostEth * 2500,
        side_a_tx: txHash,
        side_b_tx: txHash,
        error_message: errorMsg || null,
      });
    }
  } catch (err) {
    console.error("[LIM] Supabase log error:", err);
  }
}

// ── Check USDC Balance ──────────────────────────────────
async function checkBalance(): Promise<number> {
  try {
    const balance = await publicClient.readContract({
      address: CONFIG.LIMITLESS_USDC as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const usdcBalance = Number(formatUnits(balance, 6));
    console.log(`[LIM] USDC balance: $${usdcBalance.toFixed(2)}`);
    return usdcBalance;
  } catch {
    console.error("[LIM] Failed to check USDC balance");
    return 0;
  }
}

// ── Main Loop ───────────────────────────────────────────
async function main(): Promise<void> {
  // Pre-fetch fee rate so profit math is accurate from scan #1
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["X-API-Key"] = CONFIG.LIMITLESS_API_KEY;
  try {
    const feeRes = await fetchWithRetry(`${CONFIG.LIMITLESS_API}/profiles/${account.address}`, { headers });
    if (feeRes.ok) {
      const feeData = await feeRes.json();
      cachedFeeRateBps = Number(feeData?.rank?.feeRateBps ?? feeData?.feeRateBps ?? 0);
      console.log(`[LIM] Account fee rate: ${cachedFeeRateBps} bps (${(cachedFeeRateBps / 100).toFixed(1)}%)`);
    }
  } catch {}

  const balance = await checkBalance();
  if (balance < CONFIG.LIMITLESS_TRADE_SIZE_USD) {
    console.error(`[LIM] ❌ Insufficient USDC: $${balance.toFixed(2)} < $${CONFIG.LIMITLESS_TRADE_SIZE_USD}`);
    console.error("[LIM] Fund your Base wallet with USDC and ETH (for gas)");
    return;
  }

  let scanCount = 0;

  while (true) {
    scanCount++;
    console.log(`\n[LIM] ── Scan #${scanCount} ──────────────────────────`);

    try {
      const markets = await fetchMarkets();
      const opps = findArbs(markets);

      if (opps.length === 0) {
        console.log("[LIM] No arb opportunities found");
      } else {
        console.log(`[LIM] 🔥 Found ${opps.length} opportunities:`);
        for (const opp of opps) {
          const dir = opp.direction === "merge" ? "MERGE (buy+merge)" : "SPLIT (split+sell)";
          console.log(
            `  ${dir} "${opp.market.title.slice(0, 40)}" ` +
            `spread=${(opp.spread * 100).toFixed(2)}% net=$${opp.netProfit.toFixed(4)}`
          );
        }

        const best = opps[0];
        if (best.direction === 'merge') {
          await executeMergeArb(best);
        } else {
          console.log('[LIM] Split arbs are temporarily disabled until dual-leg execution is made hedge-safe.');
        }
      }
    } catch (err) {
      console.error("[LIM] Scan error:", err);
    }

    await sleep(CONFIG.LIMITLESS_SCAN_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[LIM] Fatal error:", err);
  process.exit(1);
});
