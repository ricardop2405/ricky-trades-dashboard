
-- Allow authenticated users to READ trading data (for the dashboard)
CREATE POLICY "authenticated_read_whale_trades" ON public.whale_trades FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_bundle_results" ON public.bundle_results FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_arb_executions" ON public.arb_executions FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_arb_opportunities" ON public.arb_opportunities FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_gnosis_arb_opportunities" ON public.gnosis_arb_opportunities FOR SELECT TO authenticated USING (true);
