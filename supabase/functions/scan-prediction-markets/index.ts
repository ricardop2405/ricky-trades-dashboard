import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const MANIFOLD_API = "https://api.manifold.markets/v0";

interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  outcomePrices: string;
  volume: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  category?: string;
  slug?: string;
}

interface ManifoldMarket {
  id: string;
  question: string;
  probability?: number;
  volume: number;
  closeTime?: number;
  isResolved: boolean;
  mechanism: string;
  outcomeType: string;
  url: string;
  slug: string;
  groupSlugs?: string[];
}

// Simple keyword extraction for fuzzy matching
function extractKeywords(question: string): string[] {
  const stopWords = new Set([
    "will", "the", "a", "an", "in", "on", "at", "to", "for", "of", "is",
    "be", "by", "it", "or", "and", "this", "that", "with", "from", "as",
    "are", "was", "were", "been", "has", "have", "had", "do", "does",
    "did", "but", "not", "what", "which", "who", "whom", "how", "when",
    "where", "why", "before", "after", "during", "than", "more", "most",
    "any", "each", "every", "all", "both", "few", "some", "such", "no",
    "yes", "if", "then", "so", "up", "out", "about", "into", "over",
    "between", "through", "its", "his", "her", "their", "our", "my",
    "your", "can", "could", "would", "should", "may", "might", "must",
    "shall", "being", "there", "here", "other", "own", "same", "also",
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

// Calculate keyword overlap score between two questions
function matchScore(qA: string, qB: string): number {
  const kwA = extractKeywords(qA);
  const kwB = new Set(extractKeywords(qB));
  if (kwA.length === 0 || kwB.size === 0) return 0;
  const overlap = kwA.filter((w) => kwB.has(w)).length;
  return overlap / Math.max(kwA.length, kwB.size);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── 1. Fetch Polymarket ──────────────────────────────────
    let polyMarkets: GammaMarket[] = [];
    try {
      const polyRes = await fetch(`${GAMMA_API}/markets?closed=false&active=true&limit=200`);
      polyMarkets = await polyRes.json();
    } catch (e) {
      console.error("Polymarket fetch error:", e);
    }

    const polyUpserts = polyMarkets
      .filter((m) => m.outcomePrices && m.active && !m.closed && (m.id || m.condition_id))
      .map((m) => {
        let prices: number[] = [];
        try { prices = JSON.parse(m.outcomePrices).map(Number); } catch { /* skip */ }
        return {
          platform: "polymarket",
          external_id: m.condition_id || m.id,
          question: m.question,
          yes_price: prices[0] ?? 0,
          no_price: prices[1] ?? 0,
          volume: parseFloat(m.volume || "0") || 0,
          end_date: m.endDate || null,
          category: m.category || null,
          url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
          last_synced_at: new Date().toISOString(),
        };
      })
      .filter((m) => m.yes_price > 0 || m.no_price > 0);

    // ── 2. Fetch Manifold Markets ────────────────────────────
    let manifoldMarkets: ManifoldMarket[] = [];
    try {
      const mfRes = await fetch(`${MANIFOLD_API}/markets?limit=500`);
      const mfData = await mfRes.json();
      manifoldMarkets = Array.isArray(mfData) ? mfData : [];
    } catch (e) {
      console.error("Manifold fetch error:", e);
    }

    const manifoldUpserts = manifoldMarkets
      .filter((m) => !m.isResolved && m.outcomeType === "BINARY" && m.probability != null)
      .map((m) => ({
        platform: "manifold",
        external_id: m.id,
        question: m.question,
        yes_price: m.probability ?? 0,
        no_price: m.probability != null ? 1 - m.probability : 0,
        volume: m.volume || 0,
        end_date: m.closeTime ? new Date(m.closeTime).toISOString() : null,
        category: m.groupSlugs?.[0] || null,
        url: `https://manifold.markets/${m.slug}`,
        last_synced_at: new Date().toISOString(),
      }))
      .filter((m) => m.yes_price > 0);

    // ── 3. Upsert all markets ────────────────────────────────
    const allUpserts = [...polyUpserts, ...manifoldUpserts];
    if (allUpserts.length > 0) {
      const { error: upsertErr } = await supabase
        .from("prediction_markets")
        .upsert(allUpserts, { onConflict: "platform,external_id" });
      if (upsertErr) throw new Error(`Upsert error: ${upsertErr.message}`);
    }

    // ── 4. Load all markets for arb detection ────────────────
    const { data: allMarkets, error: fetchErr } = await supabase
      .from("prediction_markets")
      .select("*")
      .gt("volume", 50);
    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);

    const polyMkts = (allMarkets || []).filter((m) => m.platform === "polymarket");
    const manifoldMkts = (allMarkets || []).filter((m) => m.platform === "manifold");

    const opportunities: {
      market_a_id: string;
      market_b_id: string;
      side_a: string;
      side_b: string;
      price_a: number;
      price_b: number;
      spread: number;
      status: string;
    }[] = [];

    // ── 5a. Intra-market arb (YES + NO < 1 on same market) ──
    for (const market of allMarkets || []) {
      const sum = Number(market.yes_price) + Number(market.no_price);
      const spread = 1 - sum;
      if (spread > 0.02) {
        opportunities.push({
          market_a_id: market.id,
          market_b_id: market.id,
          side_a: "yes",
          side_b: "no",
          price_a: Number(market.yes_price),
          price_b: Number(market.no_price),
          spread,
          status: "open",
        });
      }
    }

    // ── 5b. Cross-platform arb (Polymarket vs Manifold) ──────
    // For each Polymarket market, find best Manifold match
    const MATCH_THRESHOLD = 0.4; // minimum keyword overlap
    const MIN_CROSS_SPREAD = 0.02;

    for (const pm of polyMkts) {
      let bestMatch: typeof manifoldMkts[0] | null = null;
      let bestScore = 0;

      for (const mf of manifoldMkts) {
        const score = matchScore(pm.question, mf.question);
        if (score > bestScore && score >= MATCH_THRESHOLD) {
          bestScore = score;
          bestMatch = mf;
        }
      }

      if (!bestMatch) continue;

      // Cross-arb case 1: Buy YES on cheaper platform + NO on other
      // If PM YES + MF NO < 1 → profit
      const crossSpread1 = 1 - (Number(pm.yes_price) + Number(bestMatch.no_price));
      if (crossSpread1 > MIN_CROSS_SPREAD) {
        opportunities.push({
          market_a_id: pm.id,
          market_b_id: bestMatch.id,
          side_a: "yes",
          side_b: "no",
          price_a: Number(pm.yes_price),
          price_b: Number(bestMatch.no_price),
          spread: crossSpread1,
          status: "open",
        });
      }

      // Cross-arb case 2: Buy NO on PM + YES on MF
      const crossSpread2 = 1 - (Number(pm.no_price) + Number(bestMatch.yes_price));
      if (crossSpread2 > MIN_CROSS_SPREAD) {
        opportunities.push({
          market_a_id: pm.id,
          market_b_id: bestMatch.id,
          side_a: "no",
          side_b: "yes",
          price_a: Number(pm.no_price),
          price_b: Number(bestMatch.yes_price),
          spread: crossSpread2,
          status: "open",
        });
      }
    }

    // ── 6. Expire old opportunities ──────────────────────────
    await supabase
      .from("arb_opportunities")
      .update({ status: "expired", expired_at: new Date().toISOString() })
      .eq("status", "open")
      .lt("detected_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

    if (opportunities.length > 0) {
      const { error: insertErr } = await supabase
        .from("arb_opportunities")
        .insert(opportunities);
      if (insertErr) throw new Error(`Insert arb error: ${insertErr.message}`);
    }

    return new Response(
      JSON.stringify({
        polymarket_synced: polyUpserts.length,
        manifold_synced: manifoldUpserts.length,
        opportunities_found: opportunities.length,
        cross_platform_opps: opportunities.filter(
          (o) => o.market_a_id !== o.market_b_id
        ).length,
        total_markets_scanned: (allMarkets?.length ?? 0),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error: unknown) {
    console.error("Scanner error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
