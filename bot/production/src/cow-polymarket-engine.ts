/**
 * RICKY TRADES — CoW + Polymarket Arb Engine (Polygon)
 *
 * 100% CoW Protocol execution — NO CLOB fallback:
 *   1. Scan Polymarket for short-term crypto markets (5-15 min)
 *   2. Find YES+NO combined price < $1.00
 *   3. Submit CoW Protocol intent orders (off-chain, zero gas if unfilled)
 *   4. CoW solvers fill the order through best available route
 *   5. Merge YES+NO via CTF → guaranteed $1.00
 *
 * CoW Perks:
 *   ✅ Zero gas on failure   — intents are off-chain until matched
 *   ✅ MEV protection        — solvers can't front-run you
 *   ✅ Surplus capture       — if price drops below target, you keep extra
 *   ✅ No FOK needed         — solvers handle fill-or-nothing
 *   ✅ No partial fills      — order either fully fills or expires for free
 *
 * Usage: npm run cow
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
const MAX_MARKET_DURATION_MIN = parseInt(process.env.COW_MAX_DURATION_MIN || "15");
const DRY_RUN = process.env.COW_DRY_RUN === "true";

// ── Contracts ───────────────────────────────────────────
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address;
const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;

// ── APIs ────────────────────────────────────────────────
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com"; // only for orderbook reads
const COW_API = "https://api.cow.fi/polygon/api/v1";

// ── Validate ────────────────────────────────────────────
if (!POLYGON_PRIVATE_KEY) { console.error("[COW] Missing POLYGON_PRIVATE_KEY"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("[COW] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

// ══════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════

const account = privateKeyToAccount(POLYGON_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });
const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URL) });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("═══════════════════════════════════════════════════════");
console.log("  RICKY TRADES — CoW Polymarket Arb (Polygon)");
console.log("  100% CoW Protocol — NO CLOB execution");
console.log("═══════════════════════════════════════════════════════");
console.log(`[COW] Mode: ${DRY_RUN ? "🔍 DRY RUN (scan only)" : "⚡ LIVE TRADING"}`);
console.log(`[COW] Wallet: ${account.address}`);
console.log(`[COW] Trade size: $${TRADE_SIZE_USD}`);
console.log(`[COW] Min spread: ${(MIN_SPREAD * 100).toFixed(1)}%`);
console.log(`[COW] Max market duration: ${MAX_MARKET_DURATION_MIN} min`);
console.log(`[COW] Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
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

async function ensureApproval(token: Address, spender: Address, label: string): Promise<void> {
  const key = `${token}-${spender}`;
  if (approvedSet.has(key)) return;
  const allowance = await publicClient.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance < parseUnits("10000", 6)) {
    console.log(`[COW] Approving ${label} for ${spender.slice(0, 10)}...`);
    const hash = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[COW] ✅ ${label} approved`);
  }
  approvedSet.add(key);
}

// Market cooldowns
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 3 * 60 * 1000;

// ══════════════════════════════════════════════════════════
//  COW PROTOCOL — INTENT-BASED ORDERS
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
  chainId: 137,
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

/**
 * Get a CoW Protocol quote for a token swap.
 * Returns null if CoW can't route this pair.
 */
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
      if (res.status === 400 && body.includes("NoLiquidity")) {
        return null;
      }
      console.log(`[COW] Quote failed (${res.status}): ${body.slice(0, 120)}`);
      return null;
    }

    const data = await res.json();
    return data.quote || data;
  } catch {
    return null;
  }
}

/**
 * Submit a signed CoW Protocol order.
 * Returns the order UID if successful, null otherwise.
 */
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
      console.error(`[COW] Order submission failed (${res.status}): ${body.slice(0, 200)}`);
      return null;
    }

    const orderId = await res.json();
    console.log(`[COW] ✅ CoW order submitted: ${typeof orderId === "string" ? orderId.slice(0, 20) : JSON.stringify(orderId).slice(0, 40)}...`);
    return typeof orderId === "string" ? orderId : orderId?.uid || null;
  } catch (err) {
    console.error(`[COW] Order submission error:`, err);
    return null;
  }
}

/**
 * Check CoW order fill status
 */
async function checkCowOrderStatus(orderUid: string): Promise<"open" | "filled" | "cancelled" | "expired"> {
  try {
    const res = await fetchWithRetry(`${COW_API}/orders/${orderUid}`);
    if (!res.ok) return "open";
    const data = await res.json();
    const status = data.status || "open";
    if (status === "fulfilled") return "filled";
    if (status === "cancelled" || status === "expired") return status;
    return "open";
  } catch {
    return "open";
  }
}

// ══════════════════════════════════════════════════════════
//  MARKET SCANNER
// ══════════════════════════════════════════════════════════

async function fetchMarkets(): Promise<PolyMarket[]> {
  const markets: PolyMarket[] = [];
  const now = Date.now();
  const maxDurationMs = MAX_MARKET_DURATION_MIN * 60 * 1000;

  try {
    let totalFetched = 0;

    for (let page = 0; page < 5; page++) {
      const offset = page * 100;
      const url = `${GAMMA_API}/markets?closed=false&active=true&limit=100&offset=${offset}&order=id&ascending=false`;
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

        const timeLeft = new Date(endDate).getTime() - now;
        if (timeLeft < 30000 || timeLeft > maxDurationMs) continue;

        const text = `${m.question || ""} ${m.slug || ""}`.toLowerCase();
        if (!/\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|link|doge|ada|avax|matic|bnb|crypto|above|below)\b/.test(text)) continue;

        let tokenIds: string[];
        try { tokenIds = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; } catch { continue; }
        if (!tokenIds || tokenIds.length < 2) continue;

        markets.push({
          id: String(m.id), slug: m.slug || m.id, question: m.question || "",
          conditionId: m.conditionId, yesTokenId: tokenIds[0], noTokenId: tokenIds[1],
          yesBestAsk: 0, noBestAsk: 0, yesBestBid: 0, noBestBid: 0,
          yesAskDepth: 0, noAskDepth: 0,
          endDate, volume: Number(m.volume || 0),
          negRisk: m.negRisk === true || m.neg_risk === true,
        });
      }

      if (batch.length < 100) break;
    }

    console.log(`[COW] Scanned ${totalFetched} markets → ${markets.length} short-term crypto`);

    // Fetch orderbooks (read-only from CLOB — used for price discovery only)
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

    console.log(`[COW] ${withBooks.length} markets with orderbooks`);
    return withBooks;
  } catch (err) {
    console.error("[COW] Fetch error:", err);
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

    const maxContracts = Math.floor(TRADE_SIZE_USD / combined);
    const contracts = Math.min(maxContracts, market.yesAskDepth, market.noAskDepth);
    if (contracts <= 0) continue;

    const yesCost = contracts * market.yesBestAsk;
    const noCost = contracts * market.noBestAsk;
    const totalCost = yesCost + noCost;
    const payout = contracts;
    const estimatedGas = 0.05;
    const netProfit = payout - totalCost - estimatedGas;
    const spread = (payout - totalCost) / payout;

    if (spread < MIN_SPREAD || netProfit <= 0) continue;
    if (totalCost + estimatedGas >= payout * 0.97) continue;

    opps.push({ market, yesCost, noCost, totalCost, payout, spread, netProfit, contracts });
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ══════════════════════════════════════════════════════════
//  EXECUTION — 100% CoW PROTOCOL
// ══════════════════════════════════════════════════════════

async function executeArb(opp: ArbOpportunity): Promise<void> {
  const { market, contracts, netProfit, spread } = opp;

  console.log(`\n[COW] 🎯 ARB: "${market.question.slice(0, 60)}"`);
  console.log(`[COW]   YES=$${market.yesBestAsk.toFixed(4)} + NO=$${market.noBestAsk.toFixed(4)} = $${(market.yesBestAsk + market.noBestAsk).toFixed(4)}`);
  console.log(`[COW]   ${contracts} contracts | spread ${(spread * 100).toFixed(2)}% | profit $${netProfit.toFixed(4)}`);

  if (DRY_RUN) {
    console.log(`[COW] 🔍 DRY RUN — would execute. Skipping.`);
    return;
  }

  cooldowns.set(market.id, Date.now());

  // ── Submit CoW intent orders (zero gas if unfilled) ──
  const yesAmountRaw = parseUnits(contracts.toString(), 6).toString();
  const noAmountRaw = parseUnits(contracts.toString(), 6).toString();

  console.log(`[COW] 📡 Submitting CoW Protocol intents...`);

  // Ensure USDC.e approved for CoW settlement
  await ensureApproval(USDC_E, COW_SETTLEMENT, "USDC.e→CoW");

  // Get CoW quotes for both sides
  const [yesQuote, noQuote] = await Promise.all([
    getCowQuote(USDC_E, market.yesTokenId as Address, yesAmountRaw),
    getCowQuote(USDC_E, market.noTokenId as Address, noAmountRaw),
  ]);

  if (!yesQuote || !noQuote) {
    console.log(`[COW] ❌ No CoW liquidity for this market — skipping (cost: $0)`);
    await logExecution(opp, "no-liquidity", null, 0, 0, "No CoW liquidity available");
    return;
  }

  // Verify combined cost is still profitable
  const cowYesCost = Number(yesQuote.sellAmount) / 1e6;
  const cowNoCost = Number(noQuote.sellAmount) / 1e6;
  const cowTotal = cowYesCost + cowNoCost;

  console.log(`[COW] 💰 CoW quotes: YES=$${cowYesCost.toFixed(4)} NO=$${cowNoCost.toFixed(4)} total=$${cowTotal.toFixed(4)}`);

  if (cowTotal >= contracts) {
    console.log(`[COW] ❌ CoW total $${cowTotal.toFixed(4)} >= payout $${contracts} — not profitable, skipping (cost: $0)`);
    return;
  }

  const expectedProfit = contracts - cowTotal - 0.05;
  console.log(`[COW] 🐄 CoW Protocol — MEV protected | surplus capture | expected profit: $${expectedProfit.toFixed(4)}`);

  // Submit both orders
  const [yesOrderId, noOrderId] = await Promise.all([
    submitCowOrder(yesQuote),
    submitCowOrder(noQuote),
  ]);

  if (!yesOrderId || !noOrderId) {
    console.log(`[COW] ❌ Order submission failed — cost: $0`);
    await logExecution(opp, "submit-failed", null, 0, 0, "CoW order submission failed");
    return;
  }

  // Poll for fills (max 2 minutes)
  console.log(`[COW] ⏳ Waiting for CoW solvers to fill (max 2 min)...`);
  const deadline = Date.now() + 120_000;
  let yesFilled = false, noFilled = false;
  let yesExpired = false, noExpired = false;

  while (Date.now() < deadline) {
    await sleep(5000);

    if (!yesFilled && !yesExpired) {
      const s = await checkCowOrderStatus(yesOrderId);
      if (s === "filled") { yesFilled = true; console.log(`[COW] ✅ YES filled by solver`); }
      else if (s === "cancelled" || s === "expired") { yesExpired = true; console.log(`[COW] ⏰ YES ${s}`); }
    }

    if (!noFilled && !noExpired) {
      const s = await checkCowOrderStatus(noOrderId);
      if (s === "filled") { noFilled = true; console.log(`[COW] ✅ NO filled by solver`); }
      else if (s === "cancelled" || s === "expired") { noExpired = true; console.log(`[COW] ⏰ NO ${s}`); }
    }

    // Both filled → merge
    if (yesFilled && noFilled) break;
    // Either expired/cancelled → done (zero gas lost)
    if (yesExpired || noExpired) break;
  }

  if (yesFilled && noFilled) {
    console.log(`[COW] 🎉 Both sides filled via CoW! Merging for guaranteed $1...`);
    await mergeCTF(market, contracts, cowTotal);
    await logExecution(opp, "success", null, 0.05, contracts - cowTotal - 0.05);
  } else {
    console.log(`[COW] ⏰ Orders expired/unfilled (YES=${yesFilled}, NO=${noFilled}) — $0 gas lost`);
    // If one side filled but other didn't, we hold the tokens — they can still be sold later
    if (yesFilled && !noFilled) {
      console.log(`[COW] ℹ️ YES tokens held in wallet — can sell later or wait for NO liquidity`);
    } else if (noFilled && !yesFilled) {
      console.log(`[COW] ℹ️ NO tokens held in wallet — can sell later or wait for YES liquidity`);
    }
    await logExecution(opp, "expired", null, 0, 0, `CoW orders expired (YES=${yesFilled}, NO=${noFilled})`);
  }
}

// ══════════════════════════════════════════════════════════
//  CTF MERGE — GUARANTEED $1 PAYOUT
// ══════════════════════════════════════════════════════════

async function mergeCTF(market: PolyMarket, contracts: number, totalCost: number): Promise<void> {
  const mergeAmount = parseUnits(contracts.toFixed(6), 6);
  console.log(`[COW] ✅ Merging ${contracts} contracts via CTF...`);

  const mergeHash = await walletClient.writeContract({
    address: POLYMARKET_CTF,
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
  const gasUSD = gasMatic * 0.4;
  const finalProfit = contracts - totalCost - gasUSD;

  console.log(`[COW] ✅ MERGED! tx=${mergeHash}`);
  console.log(`[COW]   Gas: ${gasMatic.toFixed(6)} MATIC ($${gasUSD.toFixed(4)})`);
  console.log(`[COW]   🎉 FINAL P&L: +$${finalProfit.toFixed(4)}`);
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
      end_date: opp.market.endDate, category: "crypto",
      last_synced_at: new Date().toISOString(),
    }, { onConflict: "platform,external_id" }).select("id").single();
    if (!mkt) return;

    const { data: oppData } = await supabase.from("arb_opportunities").insert({
      market_a_id: mkt.id, market_b_id: mkt.id,
      side_a: "yes", side_b: "no",
      price_a: opp.market.yesBestAsk, price_b: opp.market.noBestAsk,
      spread: opp.spread, status: status.startsWith("success") ? "executed" : "failed",
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
    console.error("[COW] Log error:", err);
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
    console.log(`[COW] USDC.e balance: $${usd.toFixed(2)}`);
    return usd;
  } catch { console.error("[COW] Balance check failed"); return 0; }
}

async function main(): Promise<void> {
  const balance = await checkBalance();
  if (!DRY_RUN && balance < TRADE_SIZE_USD) {
    console.error(`[COW] ❌ Insufficient USDC.e: $${balance.toFixed(2)} < $${TRADE_SIZE_USD}`);
    console.error("[COW] Fund your Polygon wallet with USDC.e and MATIC");
    return;
  }

  // Test CoW API
  try {
    const r = await fetchWithRetry(`${COW_API}/version`, {}, 1);
    if (r.ok) console.log(`[COW] ✅ CoW Protocol API reachable on Polygon`);
    else {
      console.error(`[COW] ❌ CoW API returned ${r.status} — cannot proceed without CoW`);
      return;
    }
  } catch {
    console.error(`[COW] ❌ CoW API unreachable — cannot proceed without CoW`);
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
        for (const o of opps) {
          console.log(
            `  "${o.market.question.slice(0, 50)}" ` +
            `spread=${(o.spread * 100).toFixed(2)}% net=$${o.netProfit.toFixed(4)} ` +
            `depth=Y:${o.market.yesAskDepth}/N:${o.market.noAskDepth}`
          );
        }
        await executeArb(opps[0]);
      }
    } catch (err) {
      console.error("[COW] Scan error:", err);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => { console.error("[COW] Fatal:", err); process.exit(1); });
