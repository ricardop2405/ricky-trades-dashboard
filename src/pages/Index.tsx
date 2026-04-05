import { useState } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MempoolFeed } from "@/components/MempoolFeed";
import { PerformanceLog } from "@/components/PerformanceLog";
import { ControlPanel } from "@/components/ControlPanel";
import { StatsBar } from "@/components/StatsBar";
import { PriceChart } from "@/components/PriceChart";
import { useLiveData } from "@/hooks/useLiveData";
import { generate5MinCandles } from "@/lib/mockData";
import { Badge } from "@/components/ui/badge";

const Index = () => {
  const [candles] = useState(() => generate5MinCandles(48));
  const [minProfit, setMinProfit] = useState(0.05);
  const [jitoTip, setJitoTip] = useState(0.005);
  const [isRunning, setIsRunning] = useState(true);

  const { trades, bundles, useRealData } = useLiveData(isRunning);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <DashboardHeader />

      <main className="flex-1 p-4 space-y-4 max-w-[1600px] mx-auto w-full">
        <div className="flex items-center justify-between">
          <StatsBar bundles={bundles} />
          <Badge
            variant="outline"
            className={`ml-4 font-mono text-[10px] shrink-0 ${
              useRealData
                ? "border-success/40 text-success bg-success/5"
                : "border-warning/40 text-warning bg-warning/5"
            }`}
          >
            {useRealData ? "● LIVE DATA" : "● SIMULATED"}
          </Badge>
        </div>

        <div className="grid grid-cols-12 gap-4" style={{ height: "calc(100vh - 260px)" }}>
          <div className="col-span-4">
            <MempoolFeed trades={trades} />
          </div>

          <div className="col-span-5 flex flex-col gap-4">
            <PriceChart candles={candles} />
            <div className="flex-1 min-h-0">
              <PerformanceLog bundles={bundles} />
            </div>
          </div>

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
