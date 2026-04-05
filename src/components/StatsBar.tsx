import { BundleResult, WhaleTrade } from "@/lib/mockData";
import { TrendingUp, Zap, Clock, Target, Flame, Trophy, Activity } from "lucide-react";

interface StatsBarProps {
  bundles: BundleResult[];
  trades: WhaleTrade[];
}

export const StatsBar = ({ bundles, trades }: StatsBarProps) => {
  const totalProfit = bundles.reduce((sum, b) => sum + b.profit, 0);
  const successBundles = bundles.filter((b) => b.status === "success");
  const successRate = bundles.length > 0
    ? (successBundles.length / bundles.length) * 100
    : 0;
  const avgLatency = bundles.length > 0
    ? bundles.reduce((sum, b) => sum + b.latencyMs, 0) / bundles.length
    : 0;
  const largestProfit = successBundles.length > 0
    ? Math.max(...successBundles.map((b) => b.profit))
    : 0;

  // Win streak
  let winStreak = 0;
  for (const b of bundles) {
    if (b.status === "success") winStreak++;
    else break;
  }

  // Trades per hour (based on timestamps)
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentTrades = trades.filter((t) => t.timestamp.getTime() > oneHourAgo);

  const stats = [
    { label: "Total Profit", value: `$${totalProfit.toFixed(2)}`, icon: TrendingUp, color: "text-success" },
    { label: "Bundles", value: bundles.length.toString(), icon: Zap, color: "text-accent" },
    { label: "Win Rate", value: `${successRate.toFixed(0)}%`, icon: Target, color: "text-primary" },
    { label: "Avg Latency", value: `${avgLatency.toFixed(0)}ms`, icon: Clock, color: "text-warning" },
    { label: "Win Streak", value: winStreak.toString(), icon: Flame, color: "text-success" },
    { label: "Best Trade", value: `$${largestProfit.toFixed(2)}`, icon: Trophy, color: "text-accent" },
    { label: "Trades/hr", value: recentTrades.length.toString(), icon: Activity, color: "text-primary" },
  ];

  return (
    <div className="grid grid-cols-7 gap-2">
      {stats.map((stat) => (
        <div key={stat.label} className="glass rounded-lg px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            <stat.icon className={`h-3 w-3 ${stat.color}`} />
            <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider truncate">
              {stat.label}
            </span>
          </div>
          <span className={`text-lg font-mono font-bold ${stat.color}`}>
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
};
