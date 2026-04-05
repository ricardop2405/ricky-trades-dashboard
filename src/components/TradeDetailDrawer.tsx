import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { WhaleTrade, BundleResult } from "@/lib/mockData";
import { ExternalLink } from "lucide-react";

interface TradeDetailDrawerProps {
  trade: WhaleTrade | null;
  bundle: BundleResult | null;
  open: boolean;
  onClose: () => void;
}

const SolscanLink = ({ sig, label }: { sig: string; label?: string }) => {
  // Real tx sigs are 88 chars base58. If it looks real, link it.
  const isReal = sig.length > 20 && !sig.includes("...");
  if (!isReal) return <span className="text-muted-foreground font-mono text-xs">{sig}</span>;
  return (
    <a
      href={`https://solscan.io/tx/${sig}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:text-accent/80 font-mono text-xs inline-flex items-center gap-1 underline underline-offset-2"
    >
      {label || `${sig.slice(0, 8)}...${sig.slice(-4)}`}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-border/20">
    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
    <span className="font-mono text-xs text-foreground">{children}</span>
  </div>
);

export const TradeDetailDrawer = ({ trade, bundle, open, onClose }: TradeDetailDrawerProps) => {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="glass border-border/30">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="font-mono text-sm text-primary">
            {trade ? "WHALE TRADE DETAIL" : "BUNDLE DETAIL"}
          </DrawerTitle>
          <DrawerDescription className="text-[10px] font-mono text-muted-foreground">
            Click Solscan links to view on-chain
          </DrawerDescription>
        </DrawerHeader>

        <div className="px-4 pb-6 max-w-lg mx-auto w-full">
          {trade && (
            <>
              <Row label="Wallet">{trade.wallet}</Row>
              <Row label="Direction">
                <span className={trade.direction === "buy" ? "text-success" : "text-destructive"}>
                  {trade.direction.toUpperCase()}
                </span>
              </Row>
              <Row label="Pair">{trade.tokenIn} → {trade.tokenOut}</Row>
              <Row label="Amount">${trade.amountUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}</Row>
              <Row label="Time">{trade.timestamp.toLocaleString()}</Row>
              <Row label="Tx Signature"><SolscanLink sig={trade.txSignature} /></Row>
            </>
          )}

          {bundle && (
            <>
              <Row label="Route">{bundle.route}</Row>
              <Row label="Status">
                <span className={bundle.status === "success" ? "text-success" : "text-destructive"}>
                  {bundle.status.toUpperCase()}
                </span>
              </Row>
              <Row label="Entry">${bundle.entryAmount.toFixed(2)}</Row>
              <Row label="Exit">${bundle.exitAmount.toFixed(2)}</Row>
              <Row label="Profit">
                <span className={bundle.profit > 0 ? "text-success" : "text-muted-foreground"}>
                  +${bundle.profit.toFixed(4)}
                </span>
              </Row>
              <Row label="Jito Tip">{bundle.jitoTip.toFixed(4)} SOL</Row>
              <Row label="Latency">{bundle.latencyMs}ms</Row>
              <Row label="Time">{bundle.timestamp.toLocaleString()}</Row>
              <Row label="Bundle Tx"><SolscanLink sig={bundle.txSignature} /></Row>
              <Row label="Trigger Tx"><SolscanLink sig={bundle.triggerTx} /></Row>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
