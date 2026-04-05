import { motion, AnimatePresence } from "framer-motion";
import { WhaleTrade } from "@/lib/mockData";
import { ArrowRightLeft, AlertTriangle } from "lucide-react";

interface MempoolFeedProps {
  trades: WhaleTrade[];
  onTradeClick?: (trade: WhaleTrade) => void;
}

export const MempoolFeed = ({ trades, onTradeClick }: MempoolFeedProps) => {
  return (
    <div className="glass rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-mono font-semibold text-accent text-glow-accent">
            MEMPOOL FEED
          </h2>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground animate-pulse-glow">
          ● LIVE
        </span>
      </div>

      <div className="flex-1 overflow-y-auto scanline p-2 space-y-1">
        <AnimatePresence initial={false}>
          {trades.map((trade) => {
            const isWhale = trade.amountUSD >= 20000;
            return (
              <motion.div
                key={trade.id}
                initial={{ opacity: 0, x: -20, height: 0 }}
                animate={{ opacity: 1, x: 0, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => onTradeClick?.(trade)}
                className={`rounded px-3 py-2 font-mono text-xs cursor-pointer hover:ring-1 hover:ring-accent/30 transition-all ${
                  isWhale
                    ? "bg-warning/5 border border-warning/20"
                    : "bg-secondary/30 border border-transparent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isWhale && <AlertTriangle className="h-3 w-3 text-warning" />}
                    <span className="text-muted-foreground">{trade.wallet}</span>
                  </div>
                  <span className={`font-semibold ${isWhale ? "text-warning" : "text-foreground"}`}>
                    ${trade.amountUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-1 text-muted-foreground">
                  <span className={trade.direction === "buy" ? "text-success" : "text-destructive"}>
                    {trade.direction === "buy" ? "BUY" : "SELL"}
                  </span>
                  <span>·</span>
                  <span>{trade.tokenIn} → {trade.tokenOut}</span>
                  <span className="ml-auto text-[10px]">
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
