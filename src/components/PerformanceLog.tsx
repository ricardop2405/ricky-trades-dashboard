import { motion, AnimatePresence } from "framer-motion";
import { BundleResult } from "@/lib/mockData";
import { CheckCircle2, XCircle, Activity } from "lucide-react";

interface PerformanceLogProps {
  bundles: BundleResult[];
}

export const PerformanceLog = ({ bundles }: PerformanceLogProps) => {
  const successCount = bundles.filter((b) => b.status === "success").length;
  const revertedCount = bundles.filter((b) => b.status === "reverted").length;
  const totalProfit = bundles.reduce((sum, b) => sum + b.profit, 0);

  return (
    <div className="glass rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-mono font-semibold text-primary text-glow-primary">
              PERFORMANCE LOG
            </h2>
          </div>
          <div className="flex gap-3 text-[10px] font-mono">
            <span className="text-success">✓ {successCount}</span>
            <span className="text-destructive">✗ {revertedCount}</span>
            <span className="text-primary">+${totalProfit.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <AnimatePresence initial={false}>
          {bundles.map((bundle) => (
            <motion.div
              key={bundle.id}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded px-3 py-2 font-mono text-xs ${
                bundle.status === "success"
                  ? "bg-success/5 border border-success/15"
                  : "bg-destructive/5 border border-destructive/15"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {bundle.status === "success" ? (
                    <CheckCircle2 className="h-3 w-3 text-success" />
                  ) : (
                    <XCircle className="h-3 w-3 text-destructive" />
                  )}
                  <span className="text-foreground">{bundle.route}</span>
                </div>
                <span
                  className={`font-bold ${
                    bundle.status === "success" ? "text-success" : "text-muted-foreground"
                  }`}
                >
                  {bundle.status === "success"
                    ? `+$${bundle.profit.toFixed(4)}`
                    : "$0.00 (reverted)"}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-muted-foreground text-[10px]">
                <span>Entry: ${bundle.entryAmount.toFixed(2)}</span>
                <span>Tip: {bundle.jitoTip.toFixed(4)} SOL</span>
                <span>Latency: {bundle.latencyMs}ms</span>
                <span className="ml-auto">{bundle.timestamp.toLocaleTimeString()}</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};
