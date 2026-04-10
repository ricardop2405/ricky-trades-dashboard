import { useState } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MempoolFeed } from "@/components/MempoolFeed";
import { PerformanceLog } from "@/components/PerformanceLog";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsBar } from "@/components/StatsBar";
import { VolumeChart } from "@/components/VolumeChart";
import { TopTokens } from "@/components/TopTokens";
import { WalletTracker } from "@/components/WalletTracker";
import { TradeDetailDrawer } from "@/components/TradeDetailDrawer";
import { useLiveData } from "@/hooks/useLiveData";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import type { WhaleTrade, BundleResult } from "@/lib/mockData";

const Index = () => {
  const [minProfit, setMinProfit] = useState(0.05);
  const [jitoTip, setJitoTip] = useState(0.005);
  const [isRunning, setIsRunning] = useState(true);

  const { trades, bundles, useRealData, tokenStats, walletStats, volumeBuckets } = useLiveData(isRunning);

  const [selectedTrade, setSelectedTrade] = useState<WhaleTrade | null>(null);
  const [selectedBundle, setSelectedBundle] = useState<BundleResult | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openTrade = (trade: WhaleTrade) => {
    setSelectedTrade(trade);
    setSelectedBundle(null);
    setDrawerOpen(true);
  };

  const openBundle = (bundle: BundleResult) => {
    setSelectedBundle(bundle);
    setSelectedTrade(null);
    setDrawerOpen(true);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <DashboardHeader />

      <main className="flex-1 p-4 space-y-3 max-w-[1600px] mx-auto w-full">
        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3"
        >
          <div className="flex-1 min-w-0">
            <StatsBar bundles={bundles} trades={trades} />
          </div>
          <Badge
            variant="outline"
            className={`font-mono text-[10px] shrink-0 rounded-lg px-2.5 py-1 ${
              useRealData
                ? "border-success/30 text-success bg-success/[0.06]"
                : "border-warning/30 text-warning bg-warning/[0.06]"
            }`}
          >
            {useRealData ? "● LIVE" : "● SIM"}
          </Badge>
        </motion.div>

        {/* Main grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3" style={{ minHeight: "calc(100vh - 220px)" }}>
          {/* Left: Mempool Feed */}
          <div className="md:col-span-4 min-h-[300px] md:min-h-0">
            <MempoolFeed trades={trades} onTradeClick={openTrade} />
          </div>

          {/* Center: Volume + Performance */}
          <div className="md:col-span-5 flex flex-col gap-3">
            <VolumeChart buckets={volumeBuckets} />
            <div className="flex-1 min-h-[200px]">
              <PerformanceLog bundles={bundles} onBundleClick={openBundle} />
            </div>
          </div>

          {/* Right: Tokens + Wallets + Controls */}
          <div className="md:col-span-3 flex flex-col gap-3">
            <div className="flex-1 min-h-[150px]">
              <TopTokens tokens={tokenStats} />
            </div>
            <div className="flex-1 min-h-[150px]">
              <WalletTracker wallets={walletStats} />
            </div>
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

      <TradeDetailDrawer
        trade={selectedTrade}
        bundle={selectedBundle}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
};

export default Index;
