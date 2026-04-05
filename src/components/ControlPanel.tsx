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
    <div className="glass rounded-lg p-4 space-y-5">
      <div className="flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-mono font-semibold text-accent text-glow-accent">
          CONTROLS
        </h2>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs font-mono text-muted-foreground">Min Profit Threshold</label>
            <span className="text-xs font-mono text-primary font-semibold">${minProfit.toFixed(2)}</span>
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
            <label className="text-xs font-mono text-muted-foreground">Jito Tip Amount</label>
            <span className="text-xs font-mono text-primary font-semibold">{jitoTip.toFixed(4)} SOL</span>
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

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="h-3 w-3 text-success" />
          <span className="text-[10px] font-mono text-success">
            PROFIT CHECK GUARDRAIL ACTIVE
          </span>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
          Tx reverts if final USDC {"<"} start + tip + $0.05. Reverted bundles = $0 cost.
        </p>
      </div>

      <button
        onClick={onToggle}
        className={`w-full py-2.5 rounded-md font-mono text-xs font-bold tracking-wider transition-all ${
          isRunning
            ? "bg-destructive/20 border border-destructive/40 text-destructive hover:bg-destructive/30"
            : "bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 glow-primary"
        }`}
      >
        {isRunning ? "■ STOP ENGINE" : "▶ START ENGINE"}
      </button>
    </div>
  );
};
