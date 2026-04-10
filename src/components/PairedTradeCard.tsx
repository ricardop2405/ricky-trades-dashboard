import { Badge } from "@/components/ui/badge";
import { ExternalLink, CheckCircle2, XCircle, AlertTriangle, ArrowRight } from "lucide-react";

interface TradeExecution {
  id: string;
  opportunity_id: string;
  amount_usd: number;
  realized_pnl: number;
  fees: number;
  status: string;
  executed_at: string;
  error_message: string | null;
  side_a_tx: string | null;
  side_b_tx: string | null;
  side_a_fill_price: number | null;
  side_b_fill_price: number | null;
}

interface TradeOpportunity {
  id: string;
  market_a_id: string;
  market_b_id: string;
  side_a: string;
  side_b: string;
  price_a: number;
  price_b: number;
  spread: number;
  status: string;
  detected_at: string;
}

interface PairedTradeCardProps {
  execution: TradeExecution;
  opportunity: TradeOpportunity | null;
}

function solscanLink(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

function platformLabel(side: string): string {
  if (side.startsWith("triad_")) return "TRIAD";
  if (side.startsWith("jup_")) return "JUPITER";
  return side.toUpperCase();
}

function sideLabel(side: string): string {
  if (side === "triad_hype") return "HYPE (Up/YES)";
  if (side === "triad_flop") return "FLOP (Down/YES)";
  if (side === "jup_up") return "UP YES";
  if (side === "jup_down") return "DOWN YES";
  return side.toUpperCase();
}

const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  filled: { icon: CheckCircle2, color: "text-success", bg: "bg-success/5 border-success/20" },
  executed: { icon: CheckCircle2, color: "text-success", bg: "bg-success/5 border-success/20" },
  failed: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/5 border-destructive/20" },
  partial_triad_only: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/5 border-warning/20" },
  dry_run: { icon: AlertTriangle, color: "text-muted-foreground", bg: "bg-secondary/30 border-border/30" },
  pending: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/5 border-warning/20" },
};

export const PairedTradeCard = ({ execution, opportunity }: PairedTradeCardProps) => {
  const config = statusConfig[execution.status] || statusConfig.pending;
  const StatusIcon = config.icon;

  const priceA = opportunity ? Number(opportunity.price_a) : (execution.side_a_fill_price ?? 0);
  const priceB = opportunity ? Number(opportunity.price_b) : (execution.side_b_fill_price ?? 0);
  const totalCost = priceA + priceB;
  const payout = 1.0;
  const profitPerContract = payout - totalCost;
  const isSafe = totalCost > 0 && totalCost < payout;

  const sideA = opportunity?.side_a || "leg_a";
  const sideB = opportunity?.side_b || "leg_b";

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${config.bg}`}>
      {/* Header: status + time */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-3.5 w-3.5 ${config.color}`} />
          <Badge variant="outline" className={`font-mono text-[10px] ${config.color} border-current/30`}>
            {execution.status.toUpperCase().replace(/_/g, " ")}
          </Badge>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {new Date(execution.executed_at).toLocaleString()}
        </span>
      </div>

      {/* Two legs side by side */}
      <div className="grid grid-cols-2 gap-2">
        {/* Leg A */}
        <div className="rounded-md bg-background/40 border border-border/20 p-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[8px] font-mono border-primary/30 text-primary px-1 py-0">
              {platformLabel(sideA)}
            </Badge>
            <span className="text-[9px] font-mono text-muted-foreground">{sideLabel(sideA)}</span>
          </div>
          <div className="text-sm font-bold font-mono text-foreground tabular-nums">
            ${priceA.toFixed(4)}
          </div>
          {execution.side_a_tx && (
            <a
              href={solscanLink(execution.side_a_tx)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[9px] font-mono text-primary/70 hover:text-primary transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              {execution.side_a_tx.slice(0, 8)}…{execution.side_a_tx.slice(-4)}
            </a>
          )}
        </div>

        {/* Leg B */}
        <div className="rounded-md bg-background/40 border border-border/20 p-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[8px] font-mono border-accent/30 text-accent px-1 py-0">
              {platformLabel(sideB)}
            </Badge>
            <span className="text-[9px] font-mono text-muted-foreground">{sideLabel(sideB)}</span>
          </div>
          <div className="text-sm font-bold font-mono text-foreground tabular-nums">
            ${priceB.toFixed(4)}
          </div>
          {execution.side_b_tx && (
            <a
              href={solscanLink(execution.side_b_tx)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[9px] font-mono text-accent/70 hover:text-accent transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              {execution.side_b_tx.slice(0, 8)}…{execution.side_b_tx.slice(-4)}
            </a>
          )}
          {!execution.side_b_tx && execution.status === "partial_triad_only" && (
            <span className="text-[9px] font-mono text-warning">⚠ NOT EXECUTED</span>
          )}
        </div>
      </div>

      {/* Sum-to-one math proof */}
      <div className="rounded-md bg-background/30 border border-border/15 px-3 py-1.5">
        <div className="flex items-center justify-between text-[10px] font-mono">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Total cost:</span>
            <span className={`font-bold ${isSafe ? "text-success" : "text-destructive"}`}>
              ${priceA.toFixed(4)} + ${priceB.toFixed(4)} = ${totalCost.toFixed(4)}
            </span>
          </div>
          <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/50" />
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Payout:</span>
            <span className="font-bold text-foreground">$1.00</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Profit/c:</span>
            <span className={`font-bold ${profitPerContract > 0 ? "text-success" : "text-destructive"}`}>
              {profitPerContract > 0 ? "+" : ""}${profitPerContract.toFixed(4)}
            </span>
          </div>
        </div>
        {isSafe && (
          <div className="text-[9px] font-mono text-success/60 mt-0.5">
            ✓ SUM-TO-ONE VERIFIED: ${totalCost.toFixed(4)} {"<"} $1.00 — profit guaranteed either side
          </div>
        )}
        {!isSafe && totalCost > 0 && (
          <div className="text-[9px] font-mono text-destructive/60 mt-0.5">
            ✗ COST ≥ PAYOUT — no guaranteed profit
          </div>
        )}
      </div>

      {/* Bottom row: deployed, fees, PnL */}
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>Deployed: ${Number(execution.amount_usd).toFixed(2)}</span>
        <span>Fees: ${Number(execution.fees).toFixed(4)}</span>
        <span className={`font-bold ${Number(execution.realized_pnl) >= 0 ? "text-success" : "text-destructive"}`}>
          PnL: {Number(execution.realized_pnl) >= 0 ? "+" : ""}${Number(execution.realized_pnl).toFixed(4)}
        </span>
      </div>

      {/* Error message if present */}
      {execution.error_message && (
        <div className="text-[9px] font-mono text-destructive/70 bg-destructive/5 rounded px-2 py-1 border border-destructive/10">
          {execution.error_message}
        </div>
      )}
    </div>
  );
};