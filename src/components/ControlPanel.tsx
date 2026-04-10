import { Slider } from "@/components/ui/slider";
import { Settings2, Shield } from "lucide-react";

interface ControlPanelProps {
  minProfit: number;
  setMinProfit: (v: number) => void;
  jitoTip: number;
  setJitoTip: (v: number) => void;
  isRunning: boolean;
  onToggle: () => void;
}

export const ControlPanel = ({
  minProfit,
  setMinProfit,
  jitoTip,
  setJitoTip,
  isRunning,
  onToggle,
}: ControlPanelProps) => {
  return (
    <div className="glass rounded-xl p-4 space-y-5 gradient-border">
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-accent/10 flex items-center justify-center">
          <Settings2 className="h-3.5 w-3.5 text-accent" />
        </div>
        <h2 className="text-sm font-mono font-semibold text-accent">
          CONTROLS
        </h2>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs font-mono text-muted-foreground">Min Profit</label>
            <span className="text-xs font-mono text-primary font-semibold tabular-nums">${minProfit.toFixed(2)}</span>
          </div>
          <Slider
            value={[minProfit]}
            onValueChange={([v]) => setMinProfit(v)}
            min={0.01}
            max={5}
            step={0.01}
            className="w-full"
          />
        </div>

        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs font-mono text-muted-foreground">Jito Tip</label>
            <span className="text-xs font-mono text-primary font-semibold tabular-nums">{jitoTip.toFixed(4)} SOL</span>
          </div>
          <Slider
            value={[jitoTip]}
            onValueChange={([v]) => setJitoTip(v)}
            min={0.0001}
            max={0.05}
            step={0.0001}
            className="w-full"
          />
        </div>
      </div>

      <div className="pt-3 border-t border-border/30">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="h-3 w-3 text-success" />
          <span className="text-[10px] font-mono text-success/80 tracking-wider">
            GUARDRAIL ACTIVE
          </span>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
          Tx reverts if final USDC {"<"} start + tip + $0.05
        </p>
      </div>

      <button
        onClick={onToggle}
        className={`w-full py-2.5 rounded-lg font-mono text-xs font-bold tracking-wider transition-all ${
          isRunning
            ? "bg-destructive/15 border border-destructive/30 text-destructive hover:bg-destructive/25"
            : "bg-primary/15 border border-primary/30 text-primary hover:bg-primary/25 glow-primary"
        }`}
      >
        {isRunning ? "■ STOP ENGINE" : "▶ START ENGINE"}
      </button>
    </div>
  );
};
