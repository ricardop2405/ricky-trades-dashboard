import { WalletStat } from "@/lib/mockData";
import { Eye, Repeat } from "lucide-react";

interface WalletTrackerProps {
  wallets: WalletStat[];
}

export const WalletTracker = ({ wallets }: WalletTrackerProps) => {
  const top = wallets.slice(0, 6);

  return (
    <div className="glass rounded-xl overflow-hidden h-full flex flex-col gradient-border">
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-warning/10 flex items-center justify-center">
          <Eye className="h-3.5 w-3.5 text-warning" />
        </div>
        <h2 className="text-sm font-mono font-semibold text-warning">
          WHALES
        </h2>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground/60">{wallets.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {top.map((w) => (
          <div
            key={w.wallet}
            className="rounded-lg px-3 py-2 font-mono text-xs bg-secondary/20 border border-transparent hover:border-warning/20 transition-all"
          >
            <div className="flex items-center justify-between">
              <span className="text-foreground font-semibold">{w.wallet}</span>
              <div className="flex items-center gap-1 text-warning/80">
                <Repeat className="h-3 w-3" />
                <span className="tabular-nums">{w.tradeCount}x</span>
              </div>
            </div>
            <div className="flex items-center justify-between mt-1 text-muted-foreground/50 text-[10px] tabular-nums">
              <span>
                Vol: ${w.totalVolume >= 1000000
                  ? `${(w.totalVolume / 1000000).toFixed(1)}M`
                  : `${(w.totalVolume / 1000).toFixed(0)}K`}
              </span>
              <span>Avg: ${(w.avgSize / 1000).toFixed(0)}K</span>
              <span>{w.lastSeen.toLocaleTimeString()}</span>
            </div>
          </div>
        ))}
        {top.length === 0 && (
          <div className="text-center text-muted-foreground/50 text-xs font-mono py-8">
            Waiting for trades...
          </div>
        )}
      </div>
    </div>
  );
};
