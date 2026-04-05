import { TokenStat } from "@/lib/mockData";
import { Coins } from "lucide-react";

interface TopTokensProps {
  tokens: TokenStat[];
}

export const TopTokens = ({ tokens }: TopTokensProps) => {
  const top = tokens.slice(0, 8);
  const maxVolume = top[0]?.totalVolume || 1;

  return (
    <div className="glass rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
        <Coins className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-mono font-semibold text-accent text-glow-accent">
          TOP TOKENS
        </h2>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{tokens.length} tracked</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {top.map((t) => (
          <div key={t.token} className="relative">
            <div
              className="absolute inset-0 rounded bg-accent/5"
              style={{ width: `${(t.totalVolume / maxVolume) * 100}%` }}
            />
            <div className="relative flex items-center justify-between px-3 py-2 font-mono text-xs">
              <div className="flex items-center gap-3">
                <span className="font-bold text-foreground">{t.token}</span>
                <span className="text-muted-foreground">{t.tradeCount} trades</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-success text-[10px]">↑{t.buyCount}</span>
                <span className="text-destructive text-[10px]">↓{t.sellCount}</span>
                <span className="font-semibold text-accent">
                  ${t.totalVolume >= 1000000
                    ? `${(t.totalVolume / 1000000).toFixed(1)}M`
                    : `${(t.totalVolume / 1000).toFixed(0)}K`}
                </span>
              </div>
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
