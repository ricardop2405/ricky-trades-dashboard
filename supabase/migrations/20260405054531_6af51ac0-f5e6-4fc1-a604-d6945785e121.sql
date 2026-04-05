
-- Prediction markets cached from external APIs
CREATE TABLE public.prediction_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL, -- 'polymarket' | 'drift'
  external_id text NOT NULL,
  question text NOT NULL,
  yes_price numeric NOT NULL DEFAULT 0,
  no_price numeric NOT NULL DEFAULT 0,
  volume numeric NOT NULL DEFAULT 0,
  end_date timestamp with time zone,
  category text,
  url text,
  last_synced_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(platform, external_id)
);

-- Detected arbitrage opportunities
CREATE TABLE public.arb_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_a_id uuid REFERENCES public.prediction_markets(id) ON DELETE CASCADE NOT NULL,
  market_b_id uuid REFERENCES public.prediction_markets(id) ON DELETE CASCADE NOT NULL,
  side_a text NOT NULL, -- 'yes' or 'no'
  side_b text NOT NULL,
  price_a numeric NOT NULL,
  price_b numeric NOT NULL,
  spread numeric NOT NULL, -- 1 - (price_a + price_b), positive = profit
  status text NOT NULL DEFAULT 'open', -- 'open' | 'executing' | 'executed' | 'expired'
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  expired_at timestamp with time zone
);

-- Execution results
CREATE TABLE public.arb_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid REFERENCES public.arb_opportunities(id) ON DELETE CASCADE NOT NULL,
  side_a_tx text,
  side_b_tx text,
  side_a_fill_price numeric,
  side_b_fill_price numeric,
  amount_usd numeric NOT NULL DEFAULT 0,
  realized_pnl numeric NOT NULL DEFAULT 0,
  fees numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending', -- 'pending' | 'partial' | 'filled' | 'failed'
  error_message text,
  executed_at timestamp with time zone NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.prediction_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arb_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arb_executions ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Anyone can view prediction markets" ON public.prediction_markets FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can view arb opportunities" ON public.arb_opportunities FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can view arb executions" ON public.arb_executions FOR SELECT TO public USING (true);

-- Service role write
CREATE POLICY "Service role inserts prediction markets" ON public.prediction_markets FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role updates prediction markets" ON public.prediction_markets FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role inserts arb opportunities" ON public.arb_opportunities FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role updates arb opportunities" ON public.arb_opportunities FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role inserts arb executions" ON public.arb_executions FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role updates arb executions" ON public.arb_executions FOR UPDATE TO service_role USING (true) WITH CHECK (true);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.arb_opportunities;
ALTER PUBLICATION supabase_realtime ADD TABLE public.arb_executions;
