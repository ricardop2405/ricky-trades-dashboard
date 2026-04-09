
-- Drop any existing overly permissive policies
DROP POLICY IF EXISTS "Allow public read whale_trades" ON public.whale_trades;
DROP POLICY IF EXISTS "Allow public read bundle_results" ON public.bundle_results;
DROP POLICY IF EXISTS "Allow public read arb_executions" ON public.arb_executions;
DROP POLICY IF EXISTS "Allow public read arb_opportunities" ON public.arb_opportunities;
DROP POLICY IF EXISTS "Allow public read gnosis_arb_opportunities" ON public.gnosis_arb_opportunities;
DROP POLICY IF EXISTS "Allow public read prediction_markets" ON public.prediction_markets;

-- whale_trades: service role only (no anon/authenticated reads)
DROP POLICY IF EXISTS "Enable read access for all users" ON public.whale_trades;
CREATE POLICY "service_role_only_whale_trades" ON public.whale_trades FOR ALL TO service_role USING (true) WITH CHECK (true);

-- bundle_results: service role only
DROP POLICY IF EXISTS "Enable read access for all users" ON public.bundle_results;
CREATE POLICY "service_role_only_bundle_results" ON public.bundle_results FOR ALL TO service_role USING (true) WITH CHECK (true);

-- arb_executions: service role only
DROP POLICY IF EXISTS "Enable read access for all users" ON public.arb_executions;
CREATE POLICY "service_role_only_arb_executions" ON public.arb_executions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- arb_opportunities: service role only
DROP POLICY IF EXISTS "Enable read access for all users" ON public.arb_opportunities;
CREATE POLICY "service_role_only_arb_opportunities" ON public.arb_opportunities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- gnosis_arb_opportunities: service role only
DROP POLICY IF EXISTS "Enable read access for all users" ON public.gnosis_arb_opportunities;
CREATE POLICY "service_role_only_gnosis_arb_opportunities" ON public.gnosis_arb_opportunities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- prediction_markets: keep public read (non-sensitive market data)
CREATE POLICY "public_read_prediction_markets" ON public.prediction_markets FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write_prediction_markets" ON public.prediction_markets FOR ALL TO service_role USING (true) WITH CHECK (true);
