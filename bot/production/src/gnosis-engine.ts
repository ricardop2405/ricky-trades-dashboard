/**
 * RICKY TRADES — Gnosis Chain Prediction Market Arb Engine
 *
 * Scans Omen (Presagio) and Azuro on Gnosis Chain for short-term
 * prediction/event markets settling within 24 hours.
 *
 * Strategies:
 *   1. Sum-to-1: Buy YES + NO when combined price < $1 on same platform
 *   2. Cross-platform: Buy cheap on one platform, sell expensive on another
 *
 * Execution via CoW Swap SDK on Gnosis Chain (MEV protection, no gas on failure).
 *
 * Usage: pm2 start ecosystem.config.js --only ricky-gnosis
 */

import { createClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  parseAbi,
  keccak256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { CONFIG } from "./config";
import { sleep } from "./utils";

// ── Supabase ────────────────────────────────────────────
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// ── Gnosis Chain clients ────────────────────────────────
const account = CONFIG.GNOSIS_PRIVATE_KEY
  ? privateKeyToAccount(CONFIG.GNOSIS_PRIVATE_KEY as `0x${string}`)
  : null;

const publicClient = createPublicClient({
  chain: gnosis,
  transport: http(CONFIG.GNOSIS_RPC_URL),
});

const walletClient = account
  ? createWalletClient({
      account,
      chain: gnosis,
      transport: http(CONFIG.GNOSIS_RPC_URL),
    })
  : null;

// ── Constants ───────────────────────────────────────────
const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d" as Address;

// Omen Factory and ConditionalTokens on Gnosis
const OMEN_FACTORY = "0x9083A2B699c0a4AD06F63580BDE2635d26a3eeF0" as Address;
const CONDITIONAL_TOKENS = "0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce" as Address;

// Azuro subgraph
const AZURO_SUBGRAPH =
  "https://thegraph.azuro.org/subgraphs/name/azuro-protocol/azuro-api-gnosis-v3";

// CoW Swap on Gnosis
const COW_API = "https://api.cow.fi/xdai/api/v1";

// ABIs for direct contract reads
const FPMM_ABI = parseAbi([
  "function calcBuyAmount(uint256 investmentAmount, uint256 outcomeIndex) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function collateralToken() view returns (address)",
]);

const CT_ABI = parseAbi([
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

function getGraphQLErrorMessage(payload: any): string | null {
  const firstError = payload?.errors?.[0];
  if (!firstError) return null;
  return firstError.message || "Unknown GraphQL error";
}

// ── Types ───────────────────────────────────────────────
interface MarketOpportunity {
  platform: "omen" | "azuro";
  marketId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  combinedPrice: number;
  spread: number;
  strategy: "sum_to_1" | "cross_platform";
  settlingAt: Date | null;
  // For omen: condition ID and outcome slot indices
  conditionId?: string;
  collateralToken?: string;
}

// ── Retry wrapper ───────────────────────────────────────
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
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[GNOSIS] ⚠️ Fetch retry ${attempt + 1}/${maxRetries} — waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError || new Error("fetchWithRetry exhausted");
}

// ═══════════════════════════════════════════════════════
//  OMEN SCANNER (Direct RPC — no subgraph needed)
// ═══════════════════════════════════════════════════════

// Factory event: FixedProductMarketMakerCreation(address indexed creator, ...)
const FPMM_CREATION_TOPIC = "0x92e0912d3d7f3192cad5c7ae3b47fb97f9c465c1dd12a5c24fd901ddb3905f43";

async function scanOmenMarkets(): Promise<MarketOpportunity[]> {
  try {
    const currentBlock = await publicClient.getBlockNumber();
    // Scan last ~3 days of blocks (~20k blocks on Gnosis at 5s/block)
    const fromBlock = currentBlock - 50000n;

    // 1. Get recent FPMM creation events from factory
    const logs = await publicClient.getLogs({
      address: OMEN_FACTORY,
      fromBlock,
      toBlock: currentBlock,
    });

    if (logs.length === 0) {
      console.log("[OMEN] No recent markets found in last ~3 days");
      return [];
    }

    // 2. Parse FPMM addresses and conditionIds from event data
    const markets: { fpmm: Address; conditionId: `0x${string}`; collateral: Address }[] = [];
    for (const log of logs) {
      const data = log.data.slice(2); // remove 0x
      const fpmm = ("0x" + data.slice(24, 64)) as Address;
      const collateral = ("0x" + data.slice(64 + 24, 128)) as Address; // word 1 = CT, word 2 = collateral
      // word 2 is collateral
      const collateralAddr = ("0x" + data.slice(128 + 24, 192)) as Address;
      // conditionId is in the dynamic array at the end
      // word 3 = offset (0xa0 = 160), word 4 = fee, word 5 = array length, word 6 = conditionId
      const conditionId = ("0x" + data.slice(384, 448)) as `0x${string}`;
      markets.push({ fpmm, conditionId, collateral: collateralAddr });
    }

    // 3. For each market, read prices via calcBuyAmount
    const ONE_WXDAI = 1000000000000000000n; // 1e18
    const opportunities: MarketOpportunity[] = [];
    const batchSize = 20; // Process in batches to avoid RPC rate limits
    const marketsToCheck = markets.slice(-batchSize); // Check most recent

    for (const market of marketsToCheck) {
      try {
        // Check liquidity first
        const supply = await publicClient.readContract({
          address: market.fpmm,
          abi: FPMM_ABI,
          functionName: "totalSupply",
        });

        if (supply === 0n) continue; // No liquidity

        // Get buy amounts for both outcomes
        const [buyYes, buyNo] = await Promise.all([
          publicClient.readContract({
            address: market.fpmm,
            abi: FPMM_ABI,
            functionName: "calcBuyAmount",
            args: [ONE_WXDAI, 0n],
          }),
          publicClient.readContract({
            address: market.fpmm,
            abi: FPMM_ABI,
            functionName: "calcBuyAmount",
            args: [ONE_WXDAI, 1n],
          }),
        ]);

        // Price = 1 / buyAmount (how much 1 xDAI gets you)
        const yesPrice = Number(ONE_WXDAI) / Number(buyYes);
        const noPrice = Number(ONE_WXDAI) / Number(buyNo);
        const combined = yesPrice + noPrice;
        const spread = Math.abs(1 - combined);

        if (spread >= CONFIG.GNOSIS_MIN_SPREAD) {
          opportunities.push({
            platform: "omen",
            marketId: market.fpmm,
            question: `Omen Market ${market.fpmm.slice(0, 10)}...`,
            yesPrice,
            noPrice,
            combinedPrice: combined,
            spread,
            strategy: "sum_to_1",
            settlingAt: null,
            conditionId: market.conditionId,
            collateralToken: market.collateral,
          });
        }
      } catch {
        // Skip markets that revert (resolved, no liquidity, etc.)
        continue;
      }
    }

    console.log(
      `[OMEN] Scanned ${marketsToCheck.length}/${markets.length} markets → ${opportunities.length} opportunities (spread ≥ ${(CONFIG.GNOSIS_MIN_SPREAD * 100).toFixed(1)}%)`
    );
    return opportunities;
  } catch (err: any) {
    console.error("[OMEN] Scan error:", err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════
//  AZURO SCANNER
// ═══════════════════════════════════════════════════════

async function scanAzuroMarkets(): Promise<MarketOpportunity[]> {
  const now = Math.floor(Date.now() / 1000);
  const maxSettlement = now + 86400;

  const query = `{
    conditions(first: 500) {
      id
      conditionId
      status
      outcomes {
        outcomeId
        currentOdds
      }
      game {
        title
        startsAt
        sport {
          name
        }
      }
      margin
    }
  }`;

  try {
    const res = await fetchWithRetry(AZURO_SUBGRAPH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const graphError = getGraphQLErrorMessage(json);
    if (graphError) {
      throw new Error(graphError);
    }

    const conditions = json?.data?.conditions || [];
    console.log(`[AZURO] Raw conditions returned: ${conditions.length}`);
    const opportunities: MarketOpportunity[] = [];

    for (const cond of conditions) {
      const startsAt = cond.game?.startsAt ? parseInt(cond.game.startsAt) : null;
      if (!startsAt || startsAt <= now || startsAt >= maxSettlement) continue;
      if (!cond.outcomes || cond.outcomes.length !== 2) continue;

      const odds1 = parseFloat(cond.outcomes[0].currentOdds || "0");
      const odds2 = parseFloat(cond.outcomes[1].currentOdds || "0");
      if (odds1 <= 1 || odds2 <= 1) continue;

      const prob1 = 1 / odds1;
      const prob2 = 1 / odds2;
      const combined = prob1 + prob2;
      const spread = Math.abs(1 - combined);

      if (combined < 1 && spread >= CONFIG.GNOSIS_MIN_SPREAD) {
        const gameTitle = cond.game?.title || "Untitled";
        const sport = cond.game?.sport?.name || "Unknown";

        opportunities.push({
          platform: "azuro",
          marketId: cond.conditionId || cond.id,
          question: `${sport}: ${gameTitle}`,
          yesPrice: prob1,
          noPrice: prob2,
          combinedPrice: combined,
          spread,
          strategy: "sum_to_1",
          settlingAt: new Date(startsAt * 1000),
        });
      }
    }

    console.log(
      `[AZURO] Scanned ${conditions.length} conditions → ${opportunities.length} opportunities`
    );
    return opportunities;
  } catch (err: any) {
    console.error("[AZURO] Scan error:", err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════
//  CROSS-PLATFORM ARB DETECTION
// ═══════════════════════════════════════════════════════

function detectCrossPlatformArbs(
  omenOpps: MarketOpportunity[],
  azuroOpps: MarketOpportunity[],
): MarketOpportunity[] {
  const crossArbs: MarketOpportunity[] = [];

  // Fuzzy match questions between platforms
  for (const omen of omenOpps) {
    for (const azuro of azuroOpps) {
      const similarity = fuzzyMatch(omen.question, azuro.question);
      if (similarity < 0.6) continue;

      // Check if buying YES on one and NO on the other is profitable
      // Buy YES where cheaper, buy NO where cheaper
      const bestYes = Math.min(omen.yesPrice, azuro.yesPrice);
      const bestNo = Math.min(omen.noPrice, azuro.noPrice);
      const crossCombined = bestYes + bestNo;

      if (crossCombined < 1 - CONFIG.GNOSIS_MIN_SPREAD) {
        crossArbs.push({
          platform: "omen", // primary
          marketId: `cross_${omen.marketId}_${azuro.marketId}`,
          question: `CROSS: ${omen.question}`,
          yesPrice: bestYes,
          noPrice: bestNo,
          combinedPrice: crossCombined,
          spread: 1 - crossCombined,
          strategy: "cross_platform",
          settlingAt: omen.settlingAt,
        });
      }
    }
  }

  if (crossArbs.length > 0) {
    console.log(`[CROSS] Found ${crossArbs.length} cross-platform arbs`);
  }
  return crossArbs;
}

function fuzzyMatch(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let matches = 0;
  for (const word of aWords) {
    if (bWords.has(word)) matches++;
  }
  return matches / Math.max(aWords.size, bWords.size);
}

// ═══════════════════════════════════════════════════════
//  COW SWAP EXECUTION
// ═══════════════════════════════════════════════════════

async function executeCowSwapOrder(
  opp: MarketOpportunity,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  if (!account || !walletClient) {
    return { success: false, error: "No wallet configured" };
  }

  if (CONFIG.GNOSIS_DRY_RUN) {
    console.log(`[COW] 🏜️ DRY RUN — Would execute: ${opp.question}`);
    console.log(`      Combined: $${opp.combinedPrice.toFixed(4)} | Spread: ${(opp.spread * 100).toFixed(2)}%`);
    return { success: true, orderId: `dry_${Date.now()}` };
  }

  try {
    // For Omen markets: use CoW Swap to buy conditional tokens
    // The trade: sell xDAI/WXDAI → buy outcome tokens via CoW
    // Post-trade: merge YES + NO → recover collateral at $1

    const tradeAmount = CONFIG.GNOSIS_TRADE_SIZE_USD;
    const amountWei = BigInt(Math.floor(tradeAmount * 1e18)).toString();

    // Step 1: Get a quote from CoW API
    const quoteBody = {
      sellToken: WXDAI,
      buyToken: opp.collateralToken || WXDAI,
      sellAmountBeforeFee: amountWei,
      from: account.address,
      kind: "sell",
      appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
      partiallyFillable: false,
    };

    const quoteRes = await fetchWithRetry(`${COW_API}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quoteBody),
    });

    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      return { success: false, error: `CoW quote failed: ${errText}` };
    }

    const quote = await quoteRes.json();

    // Step 2: Sign and submit the order
    // For a full implementation, we need EIP-712 signing of the CoW order
    // This is a simplified version — in production you'd use @cowprotocol/cow-sdk
    const order = {
      ...quote.quote,
      from: account.address,
      signingScheme: "eip712",
    };

    // Sign the order hash
    const orderDigest = quote.id;
    const signature = await walletClient.signTypedData({
      domain: {
        name: "Gnosis Protocol",
        version: "v2",
        chainId: 100,
        verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address, // GPv2Settlement
      },
      types: {
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
      },
      primaryType: "Order",
      message: quote.quote,
    });

    // Submit signed order
    const submitRes = await fetchWithRetry(`${COW_API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...quote.quote,
        from: account.address,
        signature,
        signingScheme: "eip712",
      }),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return { success: false, error: `CoW submit failed: ${errText}` };
    }

    const orderId = await submitRes.text();
    console.log(`[COW] ✅ Order submitted: ${orderId.slice(0, 16)}...`);
    return { success: true, orderId: orderId.replace(/"/g, "") };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════
//  LOG OPPORTUNITY TO SUPABASE
// ═══════════════════════════════════════════════════════

async function logOpportunity(
  opp: MarketOpportunity,
  status: string,
  profitUsd: number = 0,
  txHash?: string,
  cowOrderId?: string,
  errorMsg?: string,
) {
  try {
    const { error } = await supabase.from("gnosis_arb_opportunities").insert({
      platform: opp.platform,
      market_question: opp.question,
      market_id: opp.marketId,
      yes_price: opp.yesPrice,
      no_price: opp.noPrice,
      combined_price: opp.combinedPrice,
      spread: opp.spread,
      strategy: opp.strategy,
      status,
      profit_usd: profitUsd,
      tx_hash: txHash || null,
      cow_order_id: cowOrderId || null,
      error_message: errorMsg || null,
      settling_at: opp.settlingAt?.toISOString() || null,
    });

    if (error) console.error("[DB] Insert error:", error.message);
  } catch (err: any) {
    console.error("[DB] Log error:", err.message);
  }
}

// ═══════════════════════════════════════════════════════
//  MAIN SCAN LOOP
// ═══════════════════════════════════════════════════════

let totalScans = 0;
let totalOpportunities = 0;
let totalExecuted = 0;

async function scanAndExecute() {
  totalScans++;

  // Scan both platforms in parallel
  const [omenOpps, azuroOpps] = await Promise.all([
    scanOmenMarkets(),
    scanAzuroMarkets(),
  ]);

  // Detect cross-platform arbs
  const crossOpps = detectCrossPlatformArbs(omenOpps, azuroOpps);

  // Combine all opportunities, sort by spread (most profitable first)
  const allOpps = [...omenOpps, ...azuroOpps, ...crossOpps].sort(
    (a, b) => b.spread - a.spread,
  );

  if (allOpps.length === 0) return;

  totalOpportunities += allOpps.length;

  // Log top opportunities
  for (const opp of allOpps.slice(0, 5)) {
    console.log(
      `[${opp.platform.toUpperCase()}] ${opp.strategy} | ` +
      `YES=$${opp.yesPrice.toFixed(3)} NO=$${opp.noPrice.toFixed(3)} | ` +
      `Combined=$${opp.combinedPrice.toFixed(4)} | ` +
      `Spread=${(opp.spread * 100).toFixed(2)}% | ` +
      `${opp.question.slice(0, 60)}`
    );
  }

  // Execute on the best opportunity
  const best = allOpps[0];
  if (best.spread >= CONFIG.GNOSIS_MIN_SPREAD) {
    console.log(
      `\n[EXEC] 🎯 Best opportunity: ${best.question.slice(0, 60)}...`
    );
    console.log(
      `       Spread: ${(best.spread * 100).toFixed(2)}% | ` +
      `Est. profit: $${(best.spread * CONFIG.GNOSIS_TRADE_SIZE_USD).toFixed(2)}`
    );

    const result = await executeCowSwapOrder(best);

    if (result.success) {
      totalExecuted++;
      const estProfit = best.spread * CONFIG.GNOSIS_TRADE_SIZE_USD;
      await logOpportunity(best, "executed", estProfit, undefined, result.orderId);
      console.log(`[EXEC] ✅ Order placed via CoW Swap: ${result.orderId}`);
    } else {
      await logOpportunity(best, "failed", 0, undefined, undefined, result.error);
      console.log(`[EXEC] ❌ Failed: ${result.error}`);
    }
  }

  // Log remaining opportunities as "detected" for analysis
  for (const opp of allOpps.slice(1, 10)) {
    await logOpportunity(opp, "detected");
  }
}

// ═══════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  RICKY TRADES — Gnosis Chain Arb Engine");
  console.log("═══════════════════════════════════════════════════");
  console.log(`[GNOSIS] Wallet: ${account?.address || "NOT CONFIGURED"}`);
  console.log(`[GNOSIS] RPC: ${CONFIG.GNOSIS_RPC_URL}`);
  console.log(`[GNOSIS] Min spread: ${(CONFIG.GNOSIS_MIN_SPREAD * 100).toFixed(1)}%`);
  console.log(`[GNOSIS] Trade size: $${CONFIG.GNOSIS_TRADE_SIZE_USD}`);
  console.log(`[GNOSIS] Scan interval: ${CONFIG.GNOSIS_SCAN_INTERVAL_MS}ms`);
  console.log(`[GNOSIS] Dry run: ${CONFIG.GNOSIS_DRY_RUN}`);
  console.log(`[GNOSIS] Platforms: Omen (Presagio), Azuro`);
  console.log(`[GNOSIS] Strategies: Sum-to-1 + Cross-platform`);
  console.log("═══════════════════════════════════════════════════");

  if (!account) {
    console.warn("[GNOSIS] ⚠️ No wallet key — running in MONITOR-ONLY mode");
  }

  // Heartbeat
  setInterval(() => {
    console.log(
      `[HEARTBEAT] ${new Date().toISOString()} | ` +
      `scans=${totalScans} | opps=${totalOpportunities} | ` +
      `executed=${totalExecuted}`
    );
  }, 60_000);

  // Main loop
  while (true) {
    try {
      await scanAndExecute();
    } catch (err: any) {
      console.error("[GNOSIS] Loop error:", err.message);
    }
    await sleep(CONFIG.GNOSIS_SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
