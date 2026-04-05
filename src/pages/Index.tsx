import { useState, useEffect, useCallback, useRef } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MempoolFeed } from "@/components/MempoolFeed";
import { PerformanceLog } from "@/components/PerformanceLog";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsBar } from "@/components/StatsBar";
import { PriceChart } from "@/components/PriceChart";
import {
  WhaleTrade,
  BundleResult,
  generateWhaleTrade,
  generateBundleResult,
  generate5MinCandles,
} from "@/lib/mockData";

const MAX_FEED_ITEMS = 50;

const Index = () => {
  const [trades, setTrades] = useState<WhaleTrade[]>([]);
  const [bundles, setBundles] = useState<BundleResult[]>([]);
  const [candles] = useState(() => generate5MinCandles(48));
  const [minProfit, setMinProfit] = useState(0.05);
  const [jitoTip, setJitoTip] = useState(0.005);
  const [isRunning, setIsRunning] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(() => {
    const trade = generateWhaleTrade();
    setTrades((prev) => [trade, ...prev].slice(0, MAX_FEED_ITEMS));

    if (trade.amountUSD >= 20000) {
      const bundle = generateBundleResult(trade);
      setBundles((prev) => [bundle, ...prev].slice(0, MAX_FEED_ITEMS));
    }
  }, []);

  useEffect(() => {
    if (isRunning) {
      tick();
      intervalRef.current = setInterval(tick, 1200 + Math.random() * 2000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, tick]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <DashboardHeader />

      <main className="flex-1 p-4 space-y-4 max-w-[1600px] mx-auto w-full">
        <StatsBar bundles={bundles} />

        <div className="grid grid-cols-12 gap-4" style={{ height: "calc(100vh - 240px)" }}>
          {/* Left: Mempool Feed */}
          <div className="col-span-4">
            <MempoolFeed trades={trades} />
          </div>

          {/* Center: Chart + Performance Log */}
          <div className="col-span-5 flex flex-col gap-4">
            <PriceChart candles={candles} />
            <div className="flex-1 min-h-0">
              <PerformanceLog bundles={bundles} />
            </div>
          </div>

          {/* Right: Controls */}
          <div className="col-span-3">
            <ControlPanel
              minProfit={minProfit}
              setMinProfit={setMinProfit}
              jitoTip={jitoTip}
              setJitoTip={setJitoTip}
              isRunning={isRunning}
              onToggle={() => setIsRunning(!isRunning)}
            />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
