
-- Drop overly permissive insert policies
DROP POLICY "Service can insert whale trades" ON public.whale_trades;
DROP POLICY "Service can insert bundle results" ON public.bundle_results;

-- Restrictive insert: only service role can insert (regular anon/authenticated cannot)
CREATE POLICY "Only service role can insert whale trades" ON public.whale_trades FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Only service role can insert bundle results" ON public.bundle_results FOR INSERT TO service_role WITH CHECK (true);
