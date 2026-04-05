import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GAMMA_API = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  outcomePrices: string; // JSON string like '["0.535", "0.465"]'
  volume: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  category?: string;
  slug?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch active markets from Polymarket Gamma API
    const polyRes = await fetch(`${GAMMA_API}/markets?closed=false&active=true&limit=200`);
    const polyMarkets: GammaMarket[] = await polyRes.json();

    // 2. Upsert markets into prediction_markets
    const marketsToUpsert = polyMarkets
      .filter((m) => m.outcomePrices && m.active && !m.closed)
      .map((m) => {
        let prices: number[] = [];
        try {
          prices = JSON.parse(m.outcomePrices).map(Number);
        } catch { /* skip */ }
        return {
          platform: "polymarket",
          external_id: m.condition_id,
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

    if (marketsToUpsert.length > 0) {
      const { error: upsertErr } = await supabase
        .from("prediction_markets")
        .upsert(marketsToUpsert, { onConflict: "platform,external_id" });
      if (upsertErr) throw new Error(`Upsert error: ${upsertErr.message}`);
    }

    // 3. Detect arbitrage opportunities
    const { data: allMarkets, error: fetchErr } = await supabase
      .from("prediction_markets")
      .select("*")
      .eq("platform", "polymarket")
      .gt("volume", 100);

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

    // Expire old opportunities
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
