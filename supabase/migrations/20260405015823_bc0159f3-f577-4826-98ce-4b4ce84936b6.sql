
-- Create whale_trades table
CREATE TABLE public.whale_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_usd NUMERIC NOT NULL,
  tx_signature TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create bundle_results table
CREATE TABLE public.bundle_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route TEXT NOT NULL,
  entry_amount NUMERIC NOT NULL,
  exit_amount NUMERIC NOT NULL,
  profit NUMERIC NOT NULL DEFAULT 0,
  jito_tip NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'reverted')),
  tx_signature TEXT,
  trigger_tx TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.whale_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_results ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Anyone can view whale trades" ON public.whale_trades FOR SELECT USING (true);
CREATE POLICY "Anyone can view bundle results" ON public.bundle_results FOR SELECT USING (true);

-- Service role insert (bot writes via service key)
CREATE POLICY "Service can insert whale trades" ON public.whale_trades FOR INSERT WITH CHECK (true);
CREATE POLICY "Service can insert bundle results" ON public.bundle_results FOR INSERT WITH CHECK (true);

-- Indexes
CREATE INDEX idx_whale_trades_created ON public.whale_trades (created_at DESC);
CREATE INDEX idx_bundle_results_created ON public.bundle_results (created_at DESC);
CREATE INDEX idx_whale_trades_amount ON public.whale_trades (amount_usd DESC);
