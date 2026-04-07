CREATE TABLE public.gnosis_arb_opportunities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  platform TEXT NOT NULL,
  market_question TEXT NOT NULL,
  market_id TEXT NOT NULL,
  yes_price NUMERIC NOT NULL DEFAULT 0,
  no_price NUMERIC NOT NULL DEFAULT 0,
  combined_price NUMERIC NOT NULL DEFAULT 0,
  spread NUMERIC NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL DEFAULT 'sum_to_1',
  status TEXT NOT NULL DEFAULT 'detected',
  profit_usd NUMERIC NOT NULL DEFAULT 0,
  tx_hash TEXT,
  error_message TEXT,
  settling_at TIMESTAMP WITH TIME ZONE,
  cow_order_id TEXT
);