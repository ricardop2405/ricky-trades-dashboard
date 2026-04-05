import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.49.1/cors";

const POLYMARKET_API = "https://clob.polymarket.com";

interface PolymarketMarket {
  condition_id: string;
  question: string;
  tokens: { token_id: string; outcome: string; price: number }[];
  volume_num_fmt: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  category?: string;
  market_slug?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch active markets from Polymarket
    const polyRes = await fetch(`${POLYMARKET_API}/markets?closed=false&limit=100`);
    if (!polyRes.ok) {
      const text = await polyRes.text();
      throw new Error(`Polymarket API failed [${polyRes.status}]: ${text}`);
    }
    const polyMarkets: PolymarketMarket[] = await polyRes.json();

    // 2. Upsert markets into prediction_markets
    const marketsToUpsert = polyMarkets
      .filter((m) => m.tokens && m.tokens.length >= 2 && m.active && !m.closed)
      .map((m) => {
        const yesToken = m.tokens.find((t) => t.outcome === "Yes");
        const noToken = m.tokens.find((t) => t.outcome === "No");
        return {
          platform: "polymarket",
          external_id: m.condition_id,
          question: m.question,
          yes_price: yesToken?.price ?? 0,
          no_price: noToken?.price ?? 0,
          volume: parseFloat(m.volume_num_fmt?.replace(/[,$]/g, "") || "0") || 0,
          end_date: m.end_date_iso || null,
          category: m.category || null,
          url: m.market_slug
            ? `https://polymarket.com/event/${m.market_slug}`
            : null,
          last_synced_at: new Date().toISOString(),
        };
      });

    if (marketsToUpsert.length > 0) {
      const { error: upsertErr } = await supabase
        .from("prediction_markets")
        .upsert(marketsToUpsert, { onConflict: "platform,external_id" });
      if (upsertErr) throw new Error(`Upsert error: ${upsertErr.message}`);
    }

    // 3. Detect arbitrage opportunities within Polymarket
    // Look for markets where YES + NO prices < 0.98 (2% spread after fees)
    // This is intra-platform arb: buy both YES and NO when their sum < $1
    const { data: allMarkets, error: fetchErr } = await supabase
      .from("prediction_markets")
      .select("*")
      .eq("platform", "polymarket")
      .gt("volume", 1000); // Only liquid markets

    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);

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

    // Intra-market arb: YES + NO should sum to ~1.00
    for (const market of allMarkets || []) {
      const sum = Number(market.yes_price) + Number(market.no_price);
      const spread = 1 - sum;
      if (spread > 0.02) {
        // >2% spread = profitable after fees
        opportunities.push({
          market_a_id: market.id,
          market_b_id: market.id, // same market, both sides
          side_a: "yes",
          side_b: "no",
          price_a: Number(market.yes_price),
          price_b: Number(market.no_price),
          spread,
          status: "open",
        });
      }
    }

    // Cross-market arb: same question on different markets with price divergence
    // Group by similar questions and compare
    const questionMap = new Map<string, typeof allMarkets>();
    for (const market of allMarkets || []) {
      const key = market.question.toLowerCase().trim();
      if (!questionMap.has(key)) questionMap.set(key, []);
      questionMap.get(key)!.push(market);
    }

    // Expire old open opportunities
    await supabase
      .from("arb_opportunities")
      .update({ status: "expired", expired_at: new Date().toISOString() })
      .eq("status", "open")
      .lt("detected_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

    // Insert new opportunities
    if (opportunities.length > 0) {
      const { error: insertErr } = await supabase
        .from("arb_opportunities")
        .insert(opportunities);
      if (insertErr) throw new Error(`Insert arb error: ${insertErr.message}`);
    }

    return new Response(
      JSON.stringify({
        markets_synced: marketsToUpsert.length,
        opportunities_found: opportunities.length,
        total_markets_scanned: allMarkets?.length ?? 0,
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
