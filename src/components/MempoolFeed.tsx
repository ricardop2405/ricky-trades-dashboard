import { motion, AnimatePresence } from "framer-motion";
import { WhaleTrade } from "@/lib/mockData";
import { ArrowRightLeft, AlertTriangle } from "lucide-react";

interface MempoolFeedProps {
  trades: WhaleTrade[];
  onTradeClick?: (trade: WhaleTrade) => void;
}

export const MempoolFeed = ({ trades, onTradeClick }: MempoolFeedProps) => {
  return (
    <div className="glass rounded-xl overflow-hidden h-full flex flex-col gradient-border">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent/10 flex items-center justify-center">
            <ArrowRightLeft className="h-3.5 w-3.5 text-accent" />
          </div>
          <h2 className="text-sm font-mono font-semibold text-accent">
            MEMPOOL
          </h2>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
          </span>
          <span className="text-[10px] font-mono text-success/80">LIVE</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <AnimatePresence initial={false}>
          {trades.map((trade) => {
            const isWhale = trade.amountUSD >= 20000;
            return (
              <motion.div
                key={trade.id}
                initial={{ opacity: 0, x: -12, height: 0 }}
                animate={{ opacity: 1, x: 0, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                onClick={() => onTradeClick?.(trade)}
                className={`rounded-lg px-3 py-2 font-mono text-xs cursor-pointer transition-all hover:translate-x-0.5 ${
                  isWhale
                    ? "bg-warning/[0.06] border border-warning/15 hover:border-warning/30 hover:bg-warning/[0.1]"
                    : "bg-secondary/20 border border-transparent hover:border-border/40 hover:bg-secondary/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isWhale && <AlertTriangle className="h-3 w-3 text-warning" />}
                    <span className="text-muted-foreground">{trade.wallet}</span>
                  </div>
                  <span className={`font-semibold tabular-nums ${isWhale ? "text-warning" : "text-foreground"}`}>
                    ${trade.amountUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-muted-foreground">
                  <span className={`font-semibold ${trade.direction === "buy" ? "text-success" : "text-destructive"}`}>
                    {trade.direction === "buy" ? "BUY" : "SELL"}
                  </span>
                  <span className="text-border">·</span>
                  <span>{trade.tokenIn} → {trade.tokenOut}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60">
                    {trade.timestamp.toLocaleTimeString()}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
};
