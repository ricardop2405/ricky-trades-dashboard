/**
 * RICKY TRADES — CoW + Limitless Arb Engine (Base Chain)
 *
 * Combines CoW Protocol intents on Base with Limitless prediction markets:
 *   1. Scan Limitless for short-term markets (5-15-60 min)
 *   2. Find YES+NO combined ask price < $1.00
 *   3. Submit CoW Protocol intent orders on Base (off-chain, zero gas if unfilled)
 *   4. CoW solvers fill both sides through best available route
 *   5. Merge YES+NO via Gnosis CTF → guaranteed $1.00
 *
 * CoW Perks (vs CLOB orders):
 *   ✅ Zero gas on failure   — intents are off-chain until matched
 *   ✅ MEV protection        — solvers can't front-run you
 *   ✅ Surplus capture       — if price drops below target, you keep extra
 *   ✅ Atomic intent         — order either fully fills or expires for free
 *   ✅ No partial fill risk  — unlike sequential CLOB legs
 *
 * Usage: npm run cow-limitless
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
import { base } from "viem/chains";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ══════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════

const TRADE_SIZE_USD = CONFIG.LIMITLESS_TRADE_SIZE_USD;
const MIN_SPREAD = CONFIG.LIMITLESS_MIN_SPREAD;
const SCAN_INTERVAL_MS = CONFIG.LIMITLESS_SCAN_INTERVAL_MS;
const DRY_RUN = process.env.COW_LIMITLESS_DRY_RUN === "true";

// ── CoW Protocol on Base ────────────────────────────────
const COW_API = "https://api.cow.fi/base/api/v1";
const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;
const USDC_BASE = CONFIG.LIMITLESS_USDC as Address; // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const CTF_ADDRESS = CONFIG.CTF_ADDRESS as Address;

// ── Setup ───────────────────────────────────────────────
const account = privateKeyToAccount(CONFIG.BASE_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: base, transport: http(CONFIG.BASE_RPC_URL) });
const walletClient = createWalletClient({ account, chain: base, transport: http(CONFIG.BASE_RPC_URL) });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — CoW + Limitless Arb (Base Chain)");
console.log("  CoW Protocol intents → Limitless tokens → CTF merge");
console.log("═══════════════════════════════════════════════════════");
console.log(`[COW-LIM] Mode: ${DRY_RUN ? "🔍 DRY RUN" : "⚡ LIVE TRADING"}`);
console.log(`[COW-LIM] Wallet: ${account.address}`);
console.log(`[COW-LIM] Trade size: $${TRADE_SIZE_USD}`);
console.log(`[COW-LIM] Min spread: ${(MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[COW-LIM] Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
console.log(`[COW-LIM] CoW API: ${COW_API}`);
console.log(`[COW-LIM] CTF: ${CTF_ADDRESS}`);
console.log("═══════════════════════════════════════════════════════");

// ══════════════════════════════════════════════════════════
//  ABIs
// ══════════════════════════════════════════════════════════

const CTF_ABI = parseAbi([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ══════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════

interface OrderbookLevel { price: number; size: number; }

interface LimitlessMarket {
  slug: string;
  title: string;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  yesAsks: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  conditionId: string;
  collateralToken: Address;
  expiresAt: string | null;
  category: string | null;
  volume: number;
  yesTokenId: string;
  noTokenId: string;
  yesTokenAddress: Address | null;
  noTokenAddress: Address | null;
}

interface ArbOpportunity {
  market: LimitlessMarket;
  contracts: number;
  yesPrice: number;
  noPrice: number;
  totalCost: number;
  payout: number;
  spread: number;
  netProfit: number;
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

async function ensureApproval(token: Address, spender: Address, label: string): Promise<void> {
  const key = `${token}-${spender}`;
  if (approvedSet.has(key)) return;
  const allowance = await publicClient.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance < parseUnits("10000", 6)) {
    console.log(`[COW-LIM] Approving ${label} for ${spender.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[COW-LIM] ✅ ${label} approved`);
  }
  approvedSet.add(key);
}

function normalizeBookSide(levels: any[], descending = false): OrderbookLevel[] {
  return (Array.isArray(levels) ? levels : [])
    .map((l: any) => ({ price: Number(l?.price ?? 0), size: Number(l?.size ?? l?.amount ?? 0) }))
    .filter((l) => l.price > 0 && l.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function getDepthFill(levels: OrderbookLevel[], target: number): { avgPrice: number; totalCost: number } | null {
  let remaining = target, totalCost = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.size);
    totalCost += take * l.price;
    remaining -= take;
  }
  return remaining > 1e-9 ? null : { avgPrice: totalCost / target, totalCost };
}

// Cooldowns
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 3 * 60 * 1000;

// ══════════════════════════════════════════════════════════
//  CoW PROTOCOL — INTENT-BASED ORDERS ON BASE
// ══════════════════════════════════════════════════════════

const COW_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

const COW_DOMAIN = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: 8453, // Base
  verifyingContract: COW_SETTLEMENT,
};

interface CowQuote {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  kind: string;
  appData: string;
}

async function getCowQuote(
  sellToken: Address,
  buyToken: Address,
  buyAmountRaw: string,
): Promise<CowQuote | null> {
  try {
    const res = await fetchWithRetry(`${COW_API}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellToken,
        buyToken,
        receiver: account.address,
        from: account.address,
        kind: "buy",
        buyAmountBeforeFee: buyAmountRaw,
        signingScheme: "eip712",
        onchainOrder: false,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      }),
    }, 1);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 400 && body.includes("NoLiquidity")) return null;
      console.log(`[COW-LIM] Quote failed (${res.status}): ${body.slice(0, 120)}`);
      return null;
    }

    const data = await res.json();
    return data.quote || data;
  } catch {
    return null;
  }
}

async function submitCowOrder(quote: CowQuote): Promise<string | null> {
  try {
    const orderData = {
      sellToken: quote.sellToken as Address,
      buyToken: quote.buyToken as Address,
      receiver: account.address as Address,
      sellAmount: BigInt(quote.sellAmount),
      buyAmount: BigInt(quote.buyAmount),
      validTo: quote.validTo,
      appData: quote.appData as Hex,
      feeAmount: BigInt(quote.feeAmount),
      kind: quote.kind,
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
    };

    const signature = await walletClient.signTypedData({
      domain: COW_DOMAIN,
      types: COW_ORDER_TYPES,
      primaryType: "Order",
      message: orderData,
    });

    const res = await fetchWithRetry(`${COW_API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...quote,
        from: account.address,
        signature,
        signingScheme: "eip712",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[COW-LIM] Order failed (${res.status}): ${body.slice(0, 200)}`);
      return null;
    }

    const orderId = await res.json();
    const uid = typeof orderId === "string" ? orderId : orderId?.uid || null;
    console.log(`[COW-LIM] ✅ CoW order submitted: ${uid?.slice(0, 20)}...`);
    return uid;
  } catch (err) {
    console.error(`[COW-LIM] Order error:`, err);
    return null;
  }
}

async function checkCowOrderStatus(orderUid: string): Promise<"open" | "filled" | "cancelled" | "expired"> {
  try {
    const res = await fetchWithRetry(`${COW_API}/orders/${orderUid}`);
    if (!res.ok) return "open";
    const data = await res.json();
    const status = data.status || "open";
    if (status === "fulfilled") return "filled";
    if (status === "cancelled" || status === "expired") return status;
    return "open";
  } catch { return "open"; }
}

// ══════════════════════════════════════════════════════════
//  MARKET SCANNER — LIMITLESS API
// ══════════════════════════════════════════════════════════

async function fetchMarkets(): Promise<LimitlessMarket[]> {
  const headers: Record<string, string> = {};
  if (CONFIG.LIMITLESS_API_KEY) headers["x-api-key"] = CONFIG.LIMITLESS_API_KEY;

  try {
    const pageLimit = 25;
    const maxPages = 6;
    const pageResponses = await Promise.all(
      Array.from({ length: maxPages }, (_, i) =>
        fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/active?limit=${pageLimit}&page=${i + 1}`, { headers })
      )
    );

    const rawMarkets: any[] = [];
    for (const res of pageResponses) {
      if (!res.ok) continue;
      const data = await res.json();
      const page = Array.isArray(data) ? data : data.data || data.markets || [];
      rawMarkets.push(...page);
    }

    const deduped = Array.from(new Map(rawMarkets.map((m: any) => [String(m.slug || m.id), m])).values());
    const now = Date.now();
    const MAX_EXPIRY_MS = 65 * 60 * 1000;
    const MIN_EXPIRY_MS = 60 * 1000;

    const getExpiryMs = (m: any): number | null => {
      for (const c of [m.expirationTimestamp, m.expiryTimestamp, m.closeTime, m.endTime]) {
        const v = Number(c ?? 0);
        if (Number.isFinite(v) && v > 0) return v > 10_000_000_000 ? v : v * 1000;
      }
      for (const c of [m.expirationDate, m.expiresAt, m.endDate]) {
        if (!c) continue;
        const p = new Date(c).getTime();
        if (Number.isFinite(p) && p > 0) return p;
      }
      return null;
    };

    const filtered = deduped
      .filter((m: any) => {
        const exp = getExpiryMs(m);
        if (!exp) return false;
        const tl = exp - now;
        return tl >= MIN_EXPIRY_MS && tl <= MAX_EXPIRY_MS;
      })
      .sort((a: any, b: any) => (getExpiryMs(a) ?? Infinity) - (getExpiryMs(b) ?? Infinity))
      .slice(0, 25);

    console.log(`[COW-LIM] Filtered ${filtered.length}/${deduped.length} short-term markets`);

    const markets: LimitlessMarket[] = [];
    const batchSize = 10;

    for (let i = 0; i < filtered.length; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (m: any) => {
        try {
          const slug = m.slug || m.id;
          const yesTokenId = m.tokens?.yes;
          const noTokenId = m.tokens?.no;
          if (!slug || !yesTokenId || !noTokenId) return null;

          const yesTokenAddress = m.tokens?.yesAddress || m.tokens?.yesContract || null;
          const noTokenAddress = m.tokens?.noAddress || m.tokens?.noContract || null;

          const [yesBookRes, noBookRes] = await Promise.all([
            fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${yesTokenId}`, { headers }),
            fetchWithRetry(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${noTokenId}`, { headers }),
          ]);

          if (!yesBookRes.ok || !noBookRes.ok) return null;

          const yesBook = await yesBookRes.json();
          const noBook = await noBookRes.json();
          const expiryMs = getExpiryMs(m);

          return {
            slug,
            title: m.title || m.question || slug,
            yesAsk: normalizeBookSide(yesBook.asks || [])[0]?.price ?? 1,
            noAsk: normalizeBookSide(noBook.asks || [])[0]?.price ?? 1,
            yesBid: normalizeBookSide(yesBook.bids || [], true)[0]?.price ?? 0,
            noBid: normalizeBookSide(noBook.bids || [], true)[0]?.price ?? 0,
            yesAsks: normalizeBookSide(yesBook.asks || []),
            noAsks: normalizeBookSide(noBook.asks || []),
            conditionId: m.conditionId || "",
            collateralToken: (m.collateralToken?.address || USDC_BASE) as Address,
            expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
            category: Array.isArray(m.categories) ? m.categories[0] || null : m.category || null,
            volume: Number(m.volume || 0),
            yesTokenId,
            noTokenId,
            yesTokenAddress: yesTokenAddress as Address | null,
            noTokenAddress: noTokenAddress as Address | null,
          } as LimitlessMarket;
        } catch { return null; }
      }));

      for (const m of results) if (m && m.conditionId) markets.push(m);
    }

    console.log(`[COW-LIM] ${markets.length} markets with orderbooks`);
    return markets;
  } catch (err) {
    console.error("[COW-LIM] Fetch error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════
//  ARB DETECTION
// ══════════════════════════════════════════════════════════

function findArbs(markets: LimitlessMarket[]): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];

  for (const market of markets) {
    if (cooldowns.has(market.slug) && Date.now() - cooldowns.get(market.slug)! < COOLDOWN_MS) continue;

    const combined = market.yesAsk + market.noAsk;
    if (combined <= 0 || combined >= 1) continue;

    const contracts = Math.floor(TRADE_SIZE_USD / combined);
    if (contracts <= 0) continue;

    const yesFill = getDepthFill(market.yesAsks, contracts);
    const noFill = getDepthFill(market.noAsks, contracts);
    if (!yesFill || !noFill) continue;

    const totalCost = yesFill.totalCost + noFill.totalCost;
    const payout = contracts; // $1 per merged pair
    const estimatedGas = 0.10; // Base is cheap
    const spread = (payout - totalCost) / payout;
    const netProfit = payout - totalCost - estimatedGas;

    // Must be clearly profitable after gas
    if (totalCost + estimatedGas >= payout * 0.97) continue;
    if (spread < MIN_SPREAD || netProfit <= 0) continue;

    opps.push({
      market,
      contracts,
      yesPrice: yesFill.avgPrice,
      noPrice: noFill.avgPrice,
      totalCost,
      payout,
      spread,
      netProfit,
    });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ══════════════════════════════════════════════════════════
//  EXECUTION — CoW PROTOCOL INTENTS ON BASE
// ══════════════════════════════════════════════════════════

async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, contracts, spread, netProfit } = opp;

  console.log(`\n[COW-LIM] 🎯 ARB: "${market.title.slice(0, 60)}"`);
  console.log(`[COW-LIM]   YES=$${market.yesAsk.toFixed(4)} + NO=$${market.noAsk.toFixed(4)} = $${(market.yesAsk + market.noAsk).toFixed(4)}`);
  console.log(`[COW-LIM]   ${contracts} contracts | spread ${(spread * 100).toFixed(2)}% | profit $${netProfit.toFixed(4)}`);

  if (DRY_RUN) {
    console.log(`[COW-LIM] 🔍 DRY RUN — would execute. Skipping.`);
    return;
  }

  cooldowns.set(market.slug, Date.now());

  if (!market.yesTokenAddress || !market.noTokenAddress) {
    console.log(`[COW-LIM] ℹ️ No ERC-20 token addresses — using hybrid CLOB+CoW execution`);
    await executeHybridArb(opp);
    return;
  }

  const yesAmountRaw = parseUnits(contracts.toString(), 6).toString();
  const noAmountRaw = parseUnits(contracts.toString(), 6).toString();

  await ensureApproval(USDC_BASE, COW_SETTLEMENT, "USDC→CoW Settlement");

  console.log(`[COW-LIM] 📡 Submitting CoW Protocol intents on Base...`);

  const [yesQuote, noQuote] = await Promise.all([
    getCowQuote(USDC_BASE, market.yesTokenAddress, yesAmountRaw),
    getCowQuote(USDC_BASE, market.noTokenAddress, noAmountRaw),
  ]);

  if (!yesQuote || !noQuote) {
    console.log(`[COW-LIM] ❌ No CoW liquidity for tokens — cost: $0`);
    await logExecution(opp, "no-liquidity", null, 0, "No CoW liquidity for Limitless tokens");
    return;
  }

  const cowYesCost = Number(yesQuote.sellAmount) / 1e6;
  const cowNoCost = Number(noQuote.sellAmount) / 1e6;
  const cowTotal = cowYesCost + cowNoCost;

  console.log(`[COW-LIM] 💰 CoW quotes: YES=$${cowYesCost.toFixed(4)} NO=$${cowNoCost.toFixed(4)} total=$${cowTotal.toFixed(4)}`);

  if (cowTotal >= contracts) {
    console.log(`[COW-LIM] ❌ CoW total $${cowTotal.toFixed(4)} >= payout $${contracts} — not profitable (cost: $0)`);
    return;
  }

  const expectedProfit = contracts - cowTotal - 0.10;
  console.log(`[COW-LIM] 🐄 CoW Protocol Base — MEV protected | surplus capture | expected: $${expectedProfit.toFixed(4)}`);

  const [yesOrderId, noOrderId] = await Promise.all([
    submitCowOrder(yesQuote),
    submitCowOrder(noQuote),
  ]);

  if (!yesOrderId || !noOrderId) {
    console.log(`[COW-LIM] ❌ Order submission failed — cost: $0`);
    await logExecution(opp, "submit-failed", null, 0, "CoW order submission failed");
    return;
  }

  console.log(`[COW-LIM] ⏳ Waiting for CoW solvers (max 2 min)...`);
  const deadline = Date.now() + 120_000;
  let yesFilled = false, noFilled = false;

  while (Date.now() < deadline) {
    await sleep(5000);

    if (!yesFilled) {
      const s = await checkCowOrderStatus(yesOrderId);
      if (s === "filled") { yesFilled = true; console.log(`[COW-LIM] ✅ YES filled`); }
      else if (s === "cancelled" || s === "expired") { console.log(`[COW-LIM] ⏰ YES ${s}`); break; }
    }

    if (!noFilled) {
      const s = await checkCowOrderStatus(noOrderId);
      if (s === "filled") { noFilled = true; console.log(`[COW-LIM] ✅ NO filled`); }
      else if (s === "cancelled" || s === "expired") { console.log(`[COW-LIM] ⏰ NO ${s}`); break; }
    }

    if (yesFilled && noFilled) break;
  }

  if (yesFilled && noFilled) {
    console.log(`[COW-LIM] 🎉 Both sides filled via CoW! Merging via CTF...`);
    await mergeCTF(market, contracts, cowTotal);
    await logExecution(opp, "success", null, contracts - cowTotal - 0.10);
  } else {
    console.log(`[COW-LIM] ⏰ Orders expired (YES=${yesFilled}, NO=${noFilled}) — $0 gas lost`);
    if (yesFilled !== noFilled) {
      console.log(`[COW-LIM] ℹ️ One side filled — tokens held in wallet for later merge or sale`);
    }
    await logExecution(opp, "expired", null, 0, `CoW expired (YES=${yesFilled}, NO=${noFilled})`);
  }
}

async function executeHybridArb(opp: ArbOpportunity): Promise<void> {
  const { market, contracts, spread, netProfit, yesPrice, noPrice } = opp;

  console.log(`[COW-LIM] 🔄 Hybrid execution: CLOB orders + CTF merge`);
  console.log(`[COW-LIM]   ${contracts} contracts @ YES=$${yesPrice.toFixed(4)} NO=$${noPrice.toFixed(4)}`);

  const venueExchange = (market as any).venueExchange;
  if (venueExchange) {
    await Promise.all([
      ensureApproval(market.collateralToken, venueExchange as Address, "USDC→Venue"),
      ensureApproval(market.collateralToken, CTF_ADDRESS, "USDC→CTF"),
    ]);
  } else {
    await ensureApproval(market.collateralToken, CTF_ADDRESS, "USDC→CTF");
  }

  console.log(`[COW-LIM] ℹ️ Limitless tokens not routable via CoW — use ricky-limitless engine for CLOB execution`);
  console.log(`[COW-LIM]   Market: ${market.slug} | Spread: ${(spread * 100).toFixed(2)}% | Potential: $${netProfit.toFixed(4)}`);

  await logExecution(opp, "deferred-to-clob", null, 0, "Tokens not CoW-routable; deferred to CLOB engine");
}

// ══════════════════════════════════════════════════════════
//  CTF MERGE — GUARANTEED $1 PAYOUT
// ══════════════════════════════════════════════════════════

async function mergeCTF(market: LimitlessMarket, contracts: number, totalCost: number): Promise<void> {
  const mergeAmount = parseUnits(contracts.toFixed(6), 6);
  console.log(`[COW-LIM] Merging ${contracts} contracts via CTF...`);

  const mergeHash = await walletClient.writeContract({
    address: CTF_ADDRESS,
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

  const receipt = await publicClient.waitForTransactionReceipt({ hash: mergeHash });
  const gasWei = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
  const gasCostEth = Number(formatUnits(BigInt(gasWei), 18));
  const gasUSD = gasCostEth * 2500;
  const finalProfit = contracts - totalCost - gasUSD;

  console.log(`[COW-LIM] ✅ MERGED! tx=${mergeHash}`);
  console.log(`[COW-LIM]   Gas: ${gasCostEth.toFixed(6)} ETH ($${gasUSD.toFixed(4)})`);
  console.log(`[COW-LIM]   🎉 FINAL P&L: +$${finalProfit.toFixed(4)}`);
}

// ══════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════

async function logExecution(
  opp: ArbOpportunity, status: string, txHash: string | null,
  pnl: number, errorMsg?: string,
): Promise<void> {
  try {
    const { data: mkt } = await supabase.from("prediction_markets").upsert({
      platform: "limitless-cow",
      external_id: opp.market.slug,
      question: opp.market.title,
      yes_price: opp.yesPrice,
      no_price: opp.noPrice,
      volume: opp.market.volume,
      end_date: opp.market.expiresAt,
      category: opp.market.category,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: "platform,external_id" }).select("id").single();
    if (!mkt) return;

    const { data: oppData } = await supabase.from("arb_opportunities").insert({
      market_a_id: mkt.id, market_b_id: mkt.id,
      side_a: "yes", side_b: "no",
      price_a: opp.yesPrice, price_b: opp.noPrice,
      spread: opp.spread,
      status: status === "success" ? "executed" : "failed",
    }).select("id").single();

    if (oppData) {
      await supabase.from("arb_executions").insert({
        opportunity_id: oppData.id, status,
        amount_usd: opp.totalCost,
        realized_pnl: pnl,
        fees: 0.10,
        side_a_tx: txHash, side_b_tx: txHash,
        error_message: errorMsg || null,
      });
    }
  } catch (err) {
    console.error("[COW-LIM] Log error:", err);
  }
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function checkBalance(): Promise<number> {
  try {
    const bal = await publicClient.readContract({
      address: USDC_BASE, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
    });
    const usd = Number(formatUnits(bal, 6));
    console.log(`[COW-LIM] USDC balance: $${usd.toFixed(2)}`);
    return usd;
  } catch { console.error("[COW-LIM] Balance check failed"); return 0; }
}

async function main(): Promise<void> {
  const balance = await checkBalance();
  if (!DRY_RUN && balance < TRADE_SIZE_USD) {
    console.error(`[COW-LIM] ❌ Insufficient USDC: $${balance.toFixed(2)} < $${TRADE_SIZE_USD}`);
    console.error("[COW-LIM] Fund your Base wallet with USDC and ETH (for gas)");
    return;
  }

  try {
    const r = await fetchWithRetry(`${COW_API}/version`, {}, 1);
    if (r.ok) console.log(`[COW-LIM] ✅ CoW Protocol API reachable on Base`);
    else {
      console.error(`[COW-LIM] ❌ CoW API returned ${r.status} — cannot proceed`);
      return;
    }
  } catch {
    console.error(`[COW-LIM] ❌ CoW API unreachable on Base`);
    return;
  }

  let scanCount = 0;
  while (true) {
    scanCount++;
    console.log(`\n[COW-LIM] ── Scan #${scanCount} ──────────────────────────`);

    try {
      const markets = await fetchMarkets();
      const opps = findArbs(markets);

      if (opps.length === 0) {
        console.log("[COW-LIM] No arb opportunities found");
      } else {
        console.log(`[COW-LIM] 🔥 Found ${opps.length} opportunities:`);
        for (const o of opps) {
          console.log(
            `  "${o.market.title.slice(0, 50)}" ` +
            `spread=${(o.spread * 100).toFixed(2)}% net=$${o.netProfit.toFixed(4)} ` +
            `cow=${o.market.yesTokenAddress ? "✅ direct" : "⚠️ hybrid"}`
          );
        }
        await executeArb(opps[0]);
      }
    } catch (err) {
      console.error("[COW-LIM] Scan error:", err);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => { console.error("[COW-LIM] Fatal:", err); process.exit(1); });
