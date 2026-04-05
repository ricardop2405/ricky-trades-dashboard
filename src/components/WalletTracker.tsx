import { WalletStat } from "@/lib/mockData";
import { Eye, Repeat } from "lucide-react";

interface WalletTrackerProps {
  wallets: WalletStat[];
}

export const WalletTracker = ({ wallets }: WalletTrackerProps) => {
  const top = wallets.slice(0, 6);

  return (
    <div className="glass rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <Eye className="h-4 w-4 text-warning" />
        <h2 className="text-sm font-mono font-semibold text-warning text-glow-warning">
          WHALE WALLETS
        </h2>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{wallets.length} unique</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {top.map((w) => (
          <div
            key={w.wallet}
            className="rounded px-3 py-2 font-mono text-xs bg-secondary/30 border border-border/20 hover:border-warning/30 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-foreground font-semibold">{w.wallet}</span>
              <div className="flex items-center gap-1 text-warning">
                <Repeat className="h-3 w-3" />
                <span>{w.tradeCount}x</span>
              </div>
            </div>
            <div className="flex items-center justify-between mt-1 text-muted-foreground text-[10px]">
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
          <div className="text-center text-muted-foreground text-xs font-mono py-8">
            Waiting for trades...
          </div>
        )}
      </div>
    </div>
  );
};
