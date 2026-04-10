import { TokenStat } from "@/lib/mockData";
import { Coins } from "lucide-react";

interface TopTokensProps {
  tokens: TokenStat[];
}

export const TopTokens = ({ tokens }: TopTokensProps) => {
  const top = tokens.slice(0, 8);
  const maxVolume = top[0]?.totalVolume || 1;

  return (
    <div className="glass rounded-xl overflow-hidden h-full flex flex-col gradient-border">
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-accent/10 flex items-center justify-center">
          <Coins className="h-3.5 w-3.5 text-accent" />
        </div>
        <h2 className="text-sm font-mono font-semibold text-accent">
          TOKENS
        </h2>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground/60">{tokens.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {top.map((t, i) => (
          <div key={t.token} className="relative rounded-lg overflow-hidden">
            <div
              className="absolute inset-0 bg-accent/[0.04] rounded-lg"
              style={{ width: `${(t.totalVolume / maxVolume) * 100}%` }}
            />
            <div className="relative flex items-center justify-between px-3 py-2 font-mono text-xs">
              <div className="flex items-center gap-2.5">
                <span className="text-muted-foreground/40 text-[10px] w-3">{i + 1}</span>
                <span className="font-bold text-foreground">{t.token}</span>
                <span className="text-muted-foreground/50 text-[10px]">{t.tradeCount}x</span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="text-success text-[10px] tabular-nums">↑{t.buyCount}</span>
                <span className="text-destructive text-[10px] tabular-nums">↓{t.sellCount}</span>
                <span className="font-semibold text-accent tabular-nums">
                  ${t.totalVolume >= 1000000
                    ? `${(t.totalVolume / 1000000).toFixed(1)}M`
                    : `${(t.totalVolume / 1000).toFixed(0)}K`}
                </span>
              </div>
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
