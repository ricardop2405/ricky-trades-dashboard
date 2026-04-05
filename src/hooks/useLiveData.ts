import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { WhaleTrade, BundleResult } from "@/lib/mockData";
import { generateWhaleTrade, generateBundleResult } from "@/lib/mockData";

// DB row types from Supabase
type DbWhaleTrade = {
  id: string;
  wallet: string;
  token_in: string;
  token_out: string;
  amount_usd: number;
  tx_signature: string;
  direction: string;
  created_at: string;
};

type DbBundleResult = {
  id: string;
  route: string;
  entry_amount: number;
  exit_amount: number;
  profit: number;
  jito_tip: number;
  status: string;
  tx_signature: string | null;
  trigger_tx: string;
  latency_ms: number;
  created_at: string;
};

function dbTradeToWhaleTrade(row: DbWhaleTrade): WhaleTrade {
  return {
    id: row.id,
    timestamp: new Date(row.created_at),
    wallet: row.wallet,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    amountUSD: Number(row.amount_usd),
    txSignature: row.tx_signature,
    direction: row.direction as "buy" | "sell",
  };
}

function dbBundleToBundleResult(row: DbBundleResult): BundleResult {
  return {
    id: row.id,
    timestamp: new Date(row.created_at),
    route: row.route,
    entryAmount: Number(row.entry_amount),
    exitAmount: Number(row.exit_amount),
    profit: Number(row.profit),
    jitoTip: Number(row.jito_tip),
    status: row.status as "success" | "reverted",
    txSignature: row.tx_signature || "",
    triggerTx: row.trigger_tx,
    latencyMs: row.latency_ms,
  };
}

const MAX_ITEMS = 50;

export function useLiveData(isRunning: boolean) {
  const [trades, setTrades] = useState<WhaleTrade[]>([]);
  const [bundles, setBundles] = useState<BundleResult[]>([]);
  const [useRealData, setUseRealData] = useState(false);

  // Try to load initial data from Supabase
  useEffect(() => {
    async function loadInitial() {
      const { data: tradeRows } = await supabase
        .from("whale_trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(MAX_ITEMS);

      const { data: bundleRows } = await supabase
        .from("bundle_results")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(MAX_ITEMS);

      if (tradeRows && tradeRows.length > 0) {
        setTrades(tradeRows.map(dbTradeToWhaleTrade));
        setUseRealData(true);
      }
      if (bundleRows && bundleRows.length > 0) {
        setBundles(bundleRows.map(dbBundleToBundleResult));
        setUseRealData(true);
      }
    }
    loadInitial();
  }, []);

  // Real-time subscriptions from Supabase
  useEffect(() => {
    const channel = supabase
      .channel("live-data")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whale_trades" },
        (payload) => {
          const trade = dbTradeToWhaleTrade(payload.new as DbWhaleTrade);
          setTrades((prev) => [trade, ...prev].slice(0, MAX_ITEMS));
          setUseRealData(true);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "bundle_results" },
        (payload) => {
          const bundle = dbBundleToBundleResult(payload.new as DbBundleResult);
          setBundles((prev) => [bundle, ...prev].slice(0, MAX_ITEMS));
          setUseRealData(true);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Simulated data fallback when no real bot is running
  const tick = useCallback(() => {
    if (useRealData) return; // Skip simulation if real data is flowing

    const trade = generateWhaleTrade();
    setTrades((prev) => [trade, ...prev].slice(0, MAX_ITEMS));

    if (trade.amountUSD >= 20000) {
      const bundle = generateBundleResult(trade);
      setBundles((prev) => [bundle, ...prev].slice(0, MAX_ITEMS));
    }
  }, [useRealData]);

  useEffect(() => {
    if (!isRunning || useRealData) return;
    const interval = setInterval(tick, 1200 + Math.random() * 2000);
    tick();
    return () => clearInterval(interval);
  }, [isRunning, tick, useRealData]);

  return { trades, bundles, useRealData };
}
