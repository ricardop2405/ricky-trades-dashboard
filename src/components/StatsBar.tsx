import { BundleResult } from "@/lib/mockData";
import { TrendingUp, Zap, Clock, Target } from "lucide-react";

interface StatsBarProps {
  bundles: BundleResult[];
}

export const StatsBar = ({ bundles }: StatsBarProps) => {
  const totalProfit = bundles.reduce((sum, b) => sum + b.profit, 0);
  const successRate = bundles.length > 0
    ? (bundles.filter((b) => b.status === "success").length / bundles.length) * 100
    : 0;
  const avgLatency = bundles.length > 0
    ? bundles.reduce((sum, b) => sum + b.latencyMs, 0) / bundles.length
    : 0;

  const stats = [
    { label: "Total Profit", value: `$${totalProfit.toFixed(2)}`, icon: TrendingUp, color: "text-success" },
    { label: "Bundles Sent", value: bundles.length.toString(), icon: Zap, color: "text-accent" },
    { label: "Success Rate", value: `${successRate.toFixed(1)}%`, icon: Target, color: "text-primary" },
    { label: "Avg Latency", value: `${avgLatency.toFixed(0)}ms`, icon: Clock, color: "text-warning" },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className="glass rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <stat.icon className={`h-3.5 w-3.5 ${stat.color}`} />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
              {stat.label}
            </span>
          </div>
          <span className={`text-xl font-mono font-bold ${stat.color}`}>
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
};
