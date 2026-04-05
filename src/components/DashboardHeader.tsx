import { StatusIndicator } from "./StatusIndicator";
import { Zap } from "lucide-react";

export const DashboardHeader = () => {
  return (
    <header className="glass border-b border-border/30 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10 border border-primary/20">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight font-mono text-glow-primary text-primary">
              RICKY TRADES COMMAND
            </h1>
            <p className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase">
              Solana MEV Backrunning Terminal
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <StatusIndicator status="connected" label="RPC Connected" />
          <StatusIndicator status="scanning" label="Scanning Jupiter V6" />
          <StatusIndicator status="connected" label="Jito Relay" />
          <div className="h-6 w-px bg-border" />
          <span className="text-xs font-mono text-muted-foreground">
            Mainnet-Beta
          </span>
        </div>
      </div>
    </header>
  );
};
