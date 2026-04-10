import { motion, AnimatePresence } from "framer-motion";
import { BundleResult } from "@/lib/mockData";
import { CheckCircle2, XCircle, Activity } from "lucide-react";

interface PerformanceLogProps {
  bundles: BundleResult[];
  onBundleClick?: (bundle: BundleResult) => void;
}

export const PerformanceLog = ({ bundles, onBundleClick }: PerformanceLogProps) => {
  const successCount = bundles.filter((b) => b.status === "success").length;
  const revertedCount = bundles.filter((b) => b.status === "reverted").length;
  const totalProfit = bundles.reduce((sum, b) => sum + b.profit, 0);

  return (
    <div className="glass rounded-xl overflow-hidden h-full flex flex-col gradient-border">
      <div className="px-4 py-3 border-b border-border/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center">
              <Activity className="h-3.5 w-3.5 text-primary" />
            </div>
            <h2 className="text-sm font-mono font-semibold text-primary">
              PERFORMANCE
            </h2>
          </div>
          <div className="flex gap-3 text-[10px] font-mono">
            <span className="text-success tabular-nums">✓ {successCount}</span>
            <span className="text-destructive tabular-nums">✗ {revertedCount}</span>
            <span className="text-primary font-semibold tabular-nums">+${totalProfit.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <AnimatePresence initial={false}>
          {bundles.map((bundle) => (
            <motion.div
              key={bundle.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => onBundleClick?.(bundle)}
              className={`rounded-lg px-3 py-2 font-mono text-xs cursor-pointer transition-all hover:translate-x-0.5 ${
                bundle.status === "success"
                  ? "bg-success/[0.04] border border-success/10 hover:border-success/25"
                  : "bg-destructive/[0.04] border border-destructive/10 hover:border-destructive/25"
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
                  className={`font-bold tabular-nums ${
                    bundle.status === "success" ? "text-success" : "text-muted-foreground"
                  }`}
                >
                  {bundle.status === "success"
                    ? `+$${bundle.profit.toFixed(4)}`
                    : "$0.00"}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-muted-foreground/60 text-[10px]">
                <span>Entry: ${bundle.entryAmount.toFixed(2)}</span>
                <span>Tip: {bundle.jitoTip.toFixed(4)} SOL</span>
                <span>⚡ {bundle.latencyMs}ms</span>
                <span className="ml-auto">{bundle.timestamp.toLocaleTimeString()}</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};
