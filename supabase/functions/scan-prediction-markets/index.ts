import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DFLOW_API = "https://dev-prediction-markets-api.dflow.net";
const JUP_API = "https://api.jup.ag/prediction/v1";

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
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

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
    const jupApiKey = Deno.env.get("JUP_PREDICT_API_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── 1. Fetch ALL DFlow markets (paginate, no isInitialized filter) ──
    // 5/15-min crypto markets reset every cycle as "uninitialized"
    let dflowMarkets: any[] = [];
    let dfCursor: string | null = null;
    try {
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ limit: "100" });
        if (dfCursor) params.set("cursor", dfCursor);

        const dfRes = await fetch(`${DFLOW_API}/api/v1/markets?${params}`);
        if (!dfRes.ok) break;

        const dfData = await dfRes.json();
        const batch = Array.isArray(dfData) ? dfData : dfData.markets || dfData.data || [];
        dflowMarkets.push(...batch);

        const nextCursor = dfData.cursor || dfData.next_cursor || dfData.pagination?.cursor;
        if (!nextCursor || batch.length < 100) break;
        dfCursor = nextCursor;
      }
    } catch (e) {
      console.error("DFlow fetch error:", e);
    }

    const dflowUpserts = dflowMarkets
      .filter((m: any) => m.ticker && (m.yes_price > 0 || m.no_price > 0))
      .map((m: any) => ({
        platform: "dflow",
        external_id: m.ticker,
        question: m.title || m.ticker,
        yes_price: m.yes_price || 0,
        no_price: m.no_price || 0,
        volume: m.volume || 0,
        end_date: m.expiration_time || null,
        category: m.series_ticker || null,
        url: null,
        last_synced_at: new Date().toISOString(),
      }));

    // ── 2. Fetch Jupiter Predict markets ─────────────────────
    let jupMarkets: any[] = [];
    try {
      const jupHeaders: Record<string, string> = {};
      if (jupApiKey) jupHeaders["x-api-key"] = jupApiKey;

      const jupRes = await fetch(
        `${JUP_API}/events?includeMarkets=true&limit=200`,
        { headers: jupHeaders }
      );
      if (jupRes.ok) {
        const jupData = await jupRes.json();
        const events = Array.isArray(jupData) ? jupData : jupData.events || [];
        for (const event of events) {
          if (event.markets) {
            for (const m of event.markets) {
              jupMarkets.push({
                ...m,
                eventTitle: event.title,
              });
            }
          }
        }
      }
    } catch (e) {
      console.error("Jupiter Predict fetch error:", e);
    }

    const jupUpserts = jupMarkets
      .filter((m: any) => m.marketId && m.status === "open")
      .map((m: any) => ({
        platform: "jupiter_predict",
        external_id: m.marketId,
        question: m.eventTitle || m.metadata?.title || m.marketId,
        yes_price: (m.pricing?.buyYesPriceUsd || 0) / 1_000_000,
        no_price: (m.pricing?.buyNoPriceUsd || 0) / 1_000_000,
        volume: 0,
        end_date: m.closeTime ? new Date(m.closeTime * 1000).toISOString() : null,
        category: m.category || null,
        url: null,
        last_synced_at: new Date().toISOString(),
      }))
      .filter((m: any) => m.yes_price > 0 || m.no_price > 0);

    // ── 3. Upsert all markets ────────────────────────────────
    const allUpserts = [...dflowUpserts, ...jupUpserts];
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
      .in("platform", ["dflow", "jupiter_predict"]);
    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);

    const dfMkts = (allMarkets || []).filter((m) => m.platform === "dflow");
    const jpMkts = (allMarkets || []).filter((m) => m.platform === "jupiter_predict");

    const opportunities: any[] = [];
    const MATCH_THRESHOLD = 0.4;
    const MIN_CROSS_SPREAD = 0.02;

    // ── 5. Cross-platform arb (DFlow vs Jupiter Predict) ─────
    for (const df of dfMkts) {
      let bestMatch: any = null;
      let bestScore = 0;

      for (const jp of jpMkts) {
        const score = matchScore(df.question, jp.question);
        if (score > bestScore && score >= MATCH_THRESHOLD) {
          bestScore = score;
          bestMatch = jp;
        }
      }

      if (!bestMatch) continue;

      // Case 1: Buy YES on DFlow + NO on Jupiter
      const spread1 = 1 - (Number(df.yes_price) + Number(bestMatch.no_price));
      if (spread1 > MIN_CROSS_SPREAD) {
        opportunities.push({
          market_a_id: df.id,
          market_b_id: bestMatch.id,
          side_a: "yes",
          side_b: "no",
          price_a: Number(df.yes_price),
          price_b: Number(bestMatch.no_price),
          spread: spread1,
          status: "open",
        });
      }

      // Case 2: Buy NO on DFlow + YES on Jupiter
      const spread2 = 1 - (Number(df.no_price) + Number(bestMatch.yes_price));
      if (spread2 > MIN_CROSS_SPREAD) {
        opportunities.push({
          market_a_id: df.id,
          market_b_id: bestMatch.id,
          side_a: "no",
          side_b: "yes",
          price_a: Number(df.no_price),
          price_b: Number(bestMatch.yes_price),
          spread: spread2,
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
        dflow_synced: dflowUpserts.length,
        jupiter_synced: jupUpserts.length,
        opportunities_found: opportunities.length,
        cross_platform_opps: opportunities.length,
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