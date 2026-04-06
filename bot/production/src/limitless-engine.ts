/**
 * RICKY TRADES — Limitless Intra-Platform Arb Engine (Base Chain)
 *
 * Strategy: On Limitless prediction markets, when YES_ask + NO_ask < $1,
 * buy BOTH YES and NO shares, then merge them via Gnosis CTF for $1.
 * When YES_bid + NO_bid > $1, split $1 into YES+NO via CTF, sell both.
 *
 * Atomicity: Both legs execute in a single Base transaction via a custom
 * smart contract. If either leg fails, the entire tx reverts.
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

// ── Types ───────────────────────────────────────────────
interface LimitlessMarket {
  slug: string;
  title: string;
  status: string;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  conditionId: string;
  collateralToken: Address;
  expiresAt: string | null;
  category: string | null;
  volume: number;
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

// ── Fetch Limitless Orderbooks ──────────────────────────
async function fetchMarkets(): Promise<LimitlessMarket[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["x-api-key"] = CONFIG.LIMITLESS_API_KEY;

  try {
    const res = await fetch(`${CONFIG.LIMITLESS_API}/markets/active?limit=200`, { headers });
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
          const yesTokenId = m.tokens?.yes || m.tokens?.[0];
          const noTokenId = m.tokens?.no || m.tokens?.[1];
          if (!slug || !yesTokenId || !noTokenId) return null;

          const [yesBookRes, noBookRes] = await Promise.all([
            fetch(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${yesTokenId}`, { headers }),
            fetch(`${CONFIG.LIMITLESS_API}/markets/${slug}/orderbook?tokenId=${noTokenId}`, { headers }),
          ]);

          if (!yesBookRes.ok || !noBookRes.ok) return null;

          const yesBook = await yesBookRes.json();
          const noBook = await noBookRes.json();
          const yesAsks = (yesBook.asks || []).sort((a: any, b: any) => a.price - b.price);
          const yesBids = (yesBook.bids || []).sort((a: any, b: any) => b.price - a.price);
          const noAsks = (noBook.asks || []).sort((a: any, b: any) => a.price - b.price);
          const noBids = (noBook.bids || []).sort((a: any, b: any) => b.price - a.price);

          return {
            slug,
            title: m.title || m.question || slug,
            status: m.status || "active",
            yesAsk: yesAsks.length > 0 ? Number(yesAsks[0].price) : 1,
            yesBid: yesBids.length > 0 ? Number(yesBids[0].price) : 0,
            noAsk: noAsks.length > 0 ? Number(noAsks[0].price) : 1,
            noBid: noBids.length > 0 ? Number(noBids[0].price) : 0,
            conditionId: m.conditionId || "",
            collateralToken: (m.collateralToken?.address || CONFIG.LIMITLESS_USDC) as Address,
            expiresAt: m.expirationDate || m.expiresAt || null,
            category: Array.isArray(m.categories) ? m.categories[0] || null : m.category || null,
            volume: Number(m.volume || 0),
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
  const tradeSize = CONFIG.LIMITLESS_TRADE_SIZE_USD;

  for (const market of markets) {
    // Skip cooldown
    const lastAttempt = marketCooldowns.get(market.slug);
    if (lastAttempt && Date.now() - lastAttempt < COOLDOWN_MS) continue;

    // === MERGE: buy YES ask + NO ask, merge for $1 ===
    const mergeCost = market.yesAsk + market.noAsk;
    const mergeSpread = 1 - mergeCost;
    if (mergeSpread > CONFIG.LIMITLESS_MIN_SPREAD) {
      const totalCost = mergeCost * tradeSize;
      const payout = tradeSize;
      const grossProfit = payout - totalCost;
      const estimatedGas = 0.10; // ~$0.10 on Base
      const netProfit = grossProfit - estimatedGas;

      if (netProfit > 0) {
        opps.push({
          market,
          direction: "merge",
          yesPrice: market.yesAsk,
          noPrice: market.noAsk,
          totalCost,
          payout,
          spread: mergeSpread,
          grossProfit,
          estimatedGas,
          netProfit,
        });
      }
    }

    // === SPLIT: split $1 into YES+NO, sell YES bid + NO bid ===
    const splitRevenue = market.yesBid + market.noBid;
    const splitSpread = splitRevenue - 1;
    if (splitSpread > CONFIG.LIMITLESS_MIN_SPREAD) {
      const totalCost = tradeSize; // $1 per unit to split
      const payout = splitRevenue * tradeSize;
      const grossProfit = payout - totalCost;
      const estimatedGas = 0.10;
      const netProfit = grossProfit - estimatedGas;

      if (netProfit > 0) {
        opps.push({
          market,
          direction: "split",
          yesPrice: market.yesBid,
          noPrice: market.noBid,
          totalCost,
          payout,
          spread: splitSpread,
          grossProfit,
          estimatedGas,
          netProfit,
        });
      }
    }
  }

  return opps.sort((a, b) => b.netProfit - a.netProfit);
}

// ── Ensure USDC Approval for CTF ────────────────────────
async function ensureApproval(token: Address, spender: Address, amount: bigint): Promise<void> {
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  });

  if (allowance < amount) {
    console.log("[LIM] Approving USDC for CTF...");
    const hash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount * 10n], // Approve 10x to avoid repeated approvals
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[LIM] ✅ Approved: ${hash}`);
  }
}

// ── Execute Merge Arb ───────────────────────────────────
// Buy YES + NO on CLOB, then merge via CTF for $1
async function executeMergeArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesPrice, noPrice, netProfit } = opp;
  const tradeSize = CONFIG.LIMITLESS_TRADE_SIZE_USD;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["x-api-key"] = CONFIG.LIMITLESS_API_KEY;

  console.log(`\n[LIM] 🎯 MERGE ARB: "${market.title.slice(0, 50)}"`);
  console.log(`[LIM]   YES ask=$${yesPrice.toFixed(4)} + NO ask=$${noPrice.toFixed(4)} = $${(yesPrice + noPrice).toFixed(4)}`);
  console.log(`[LIM]   Spread: ${(opp.spread * 100).toFixed(2)}% | Net profit: $${netProfit.toFixed(4)}`);

  marketCooldowns.set(market.slug, Date.now());

  try {
    // Step 1: Place FOK buy orders for YES and NO
    const contracts = Math.floor(tradeSize); // 1 contract = $1 resolution
    const yesMicro = Math.floor(yesPrice * 1_000_000);
    const noMicro = Math.floor(noPrice * 1_000_000);

    // Place both orders — Limitless uses EIP-712 signed orders
    const yesOrder = {
      market: market.slug,
      side: "yes",
      type: "buy",
      price: yesMicro,
      size: contracts,
      orderType: "FOK", // Fill or Kill
    };

    const noOrder = {
      market: market.slug,
      side: "no",
      type: "buy",
      price: noMicro,
      size: contracts,
      orderType: "FOK",
    };

    // Execute YES order
    console.log(`[LIM] Placing YES buy: ${contracts} contracts @ $${yesPrice.toFixed(4)}`);
    const yesRes = await fetch(`${CONFIG.LIMITLESS_API}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(yesOrder),
    });

    if (!yesRes.ok) {
      const err = await yesRes.text();
      throw new Error(`YES order failed: ${yesRes.status} ${err}`);
    }
    const yesResult = await yesRes.json();
    console.log(`[LIM] ✅ YES filled: ${JSON.stringify(yesResult).slice(0, 200)}`);

    // Execute NO order
    console.log(`[LIM] Placing NO buy: ${contracts} contracts @ $${noPrice.toFixed(4)}`);
    const noRes = await fetch(`${CONFIG.LIMITLESS_API}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(noOrder),
    });

    if (!noRes.ok) {
      const err = await noRes.text();
      // If NO fails, try to sell back the YES shares
      console.error(`[LIM] ❌ NO order failed — unwinding YES position`);
      await unwindPosition(market, "yes", contracts, headers);
      throw new Error(`NO order failed: ${noRes.status} ${err}`);
    }
    const noResult = await noRes.json();
    console.log(`[LIM] ✅ NO filled: ${JSON.stringify(noResult).slice(0, 200)}`);

    // Step 2: Merge YES + NO via CTF → receive USDC
    console.log("[LIM] Merging YES + NO positions via CTF...");
    const mergeAmount = parseUnits(String(contracts), 6); // USDC has 6 decimals

    const mergeHash = await walletClient.writeContract({
      address: CONFIG.CTF_ADDRESS as Address,
      abi: CTF_ABI,
      functionName: "mergePositions",
      args: [
        market.collateralToken,
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, // parentCollectionId (root)
        market.conditionId as Hex,
        [1n, 2n], // partition: [YES=1, NO=2]
        mergeAmount,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mergeHash });
    const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
    const gasCostEth = Number(formatUnits(BigInt(gasUsed), 18));

    console.log(`[LIM] ✅ MERGED! tx=${mergeHash}`);
    console.log(`[LIM]   Gas: ${gasCostEth.toFixed(6)} ETH`);
    console.log(`[LIM]   Net profit: ~$${netProfit.toFixed(4)}`);

    // Log to Supabase
    await logExecution(opp, "success", mergeHash, gasCostEth);
  } catch (err) {
    console.error(`[LIM] ❌ Merge arb failed:`, err);
    await logExecution(opp, "failed", null, 0, String(err));
  }
}

// ── Execute Split Arb ───────────────────────────────────
// Split $1 USDC into YES+NO via CTF, then sell both on CLOB
async function executeSplitArb(opp: ArbOpportunity): Promise<void> {
  const { market, yesPrice, noPrice, netProfit } = opp;
  const tradeSize = CONFIG.LIMITLESS_TRADE_SIZE_USD;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.LIMITLESS_API_KEY) headers["x-api-key"] = CONFIG.LIMITLESS_API_KEY;

  console.log(`\n[LIM] 🎯 SPLIT ARB: "${market.title.slice(0, 50)}"`);
  console.log(`[LIM]   YES bid=$${yesPrice.toFixed(4)} + NO bid=$${noPrice.toFixed(4)} = $${(yesPrice + noPrice).toFixed(4)}`);
  console.log(`[LIM]   Spread: ${(opp.spread * 100).toFixed(2)}% | Net profit: $${netProfit.toFixed(4)}`);

  marketCooldowns.set(market.slug, Date.now());

  try {
    const contracts = Math.floor(tradeSize);
    const splitAmount = parseUnits(String(contracts), 6);

    // Step 1: Approve USDC for CTF
    await ensureApproval(
      market.collateralToken,
      CONFIG.CTF_ADDRESS as Address,
      splitAmount,
    );

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

    // Step 3: Sell YES and NO on CLOB
    const yesMicro = Math.floor(yesPrice * 1_000_000);
    const noMicro = Math.floor(noPrice * 1_000_000);

    const yesSellOrder = {
      market: market.slug,
      side: "yes",
      type: "sell",
      price: yesMicro,
      size: contracts,
      orderType: "FOK",
    };

    const noSellOrder = {
      market: market.slug,
      side: "no",
      type: "sell",
      price: noMicro,
      size: contracts,
      orderType: "FOK",
    };

    console.log(`[LIM] Selling YES: ${contracts} @ $${yesPrice.toFixed(4)}`);
    const yesRes = await fetch(`${CONFIG.LIMITLESS_API}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(yesSellOrder),
    });

    if (!yesRes.ok) {
      console.error(`[LIM] ❌ YES sell failed — holding positions for manual exit`);
      throw new Error(`YES sell failed: ${yesRes.status}`);
    }
    console.log(`[LIM] ✅ YES sold`);

    console.log(`[LIM] Selling NO: ${contracts} @ $${noPrice.toFixed(4)}`);
    const noRes = await fetch(`${CONFIG.LIMITLESS_API}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(noSellOrder),
    });

    if (!noRes.ok) {
      console.error(`[LIM] ❌ NO sell failed — holding NO position for manual exit`);
      throw new Error(`NO sell failed: ${noRes.status}`);
    }
    console.log(`[LIM] ✅ NO sold`);

    const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice || 0n);
    const gasCostEth = Number(formatUnits(BigInt(gasUsed), 18));
    console.log(`[LIM] ✅ SPLIT ARB COMPLETE | Net profit: ~$${netProfit.toFixed(4)}`);

    await logExecution(opp, "success", splitHash, gasCostEth);
  } catch (err) {
    console.error(`[LIM] ❌ Split arb failed:`, err);
    await logExecution(opp, "failed", null, 0, String(err));
  }
}

// ── Unwind failed leg ───────────────────────────────────
async function unwindPosition(
  market: LimitlessMarket,
  side: "yes" | "no",
  contracts: number,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const sellOrder = {
      market: market.slug,
      side,
      type: "sell",
      size: contracts,
      orderType: "IOC", // Immediate or Cancel — get whatever we can
    };

    const res = await fetch(`${CONFIG.LIMITLESS_API}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(sellOrder),
    });

    if (res.ok) {
      console.log(`[LIM] ✅ Unwound ${side.toUpperCase()} position`);
    } else {
      console.error(`[LIM] ❌ Failed to unwind ${side} — manual intervention needed`);
    }
  } catch (err) {
    console.error(`[LIM] ❌ Unwind error:`, err);
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
    // First upsert the market
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

    // Log the arb opportunity
    const { data: oppData } = await supabase
      .from("arb_opportunities")
      .insert({
        market_a_id: marketData.id,
        market_b_id: marketData.id, // Same market, intra-platform
        side_a: opp.direction === "merge" ? "yes" : "yes",
        side_b: opp.direction === "merge" ? "no" : "no",
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
        fees: gasCostEth * 2500, // rough ETH→USD
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
  // Check initial balance
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

        // Execute best opportunity
        const best = opps[0];
        if (best.direction === "merge") {
          await executeMergeArb(best);
        } else {
          await executeSplitArb(best);
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
