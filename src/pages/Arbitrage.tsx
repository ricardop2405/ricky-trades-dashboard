import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { DashboardHeader } from "@/components/DashboardHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowRight, TrendingUp, AlertCircle, RefreshCw, Zap } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { toast } from "sonner";

interface PredictionMarket {
  id: string;
  platform: string;
  external_id: string;
  question: string;
  yes_price: number;
  no_price: number;
  volume: number;
  category: string | null;
  url: string | null;
  last_synced_at: string;
}

interface ArbOpportunity {
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

interface ArbExecution {
  id: string;
  opportunity_id: string;
  amount_usd: number;
  realized_pnl: number;
  fees: number;
  status: string;
  executed_at: string;
  error_message: string | null;
}

const Arbitrage = () => {
  const [opportunities, setOpportunities] = useState<ArbOpportunity[]>([]);
  const [executions, setExecutions] = useState<ArbExecution[]>([]);
  const [markets, setMarkets] = useState<Map<string, PredictionMarket>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const navigate = useNavigate();

  // Load initial data
  useEffect(() => {
    loadData();
  }, []);

  // Realtime subscriptions
  useEffect(() => {
    const oppChannel = supabase
      .channel("arb-opportunities")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "arb_opportunities" },
        () => loadData()
      )
      .subscribe();

    const execChannel = supabase
      .channel("arb-executions")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "arb_executions" },
        () => loadExecutions()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(oppChannel);
      supabase.removeChannel(execChannel);
    };
  }, []);

  const loadData = async () => {
    const [oppRes, mktRes] = await Promise.all([
      supabase
        .from("arb_opportunities")
        .select("*")
        .order("spread", { ascending: false })
        .limit(50),
      supabase.from("prediction_markets").select("*").limit(500),
    ]);

    if (oppRes.data) setOpportunities(oppRes.data);
    if (mktRes.data) {
      const map = new Map<string, PredictionMarket>();
      mktRes.data.forEach((m: PredictionMarket) => map.set(m.id, m));
      setMarkets(map);
      if (mktRes.data.length > 0) {
        setLastScan(mktRes.data[0].last_synced_at);
      }
    }

    await loadExecutions();
  };

  const loadExecutions = async () => {
    const { data } = await supabase
      .from("arb_executions")
      .select("*")
      .order("executed_at", { ascending: false })
      .limit(50);
    if (data) setExecutions(data);
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "scan-prediction-markets"
      );
      if (error) throw error;
      toast.success(
        `Scanned ${data.total_markets_scanned} markets, found ${data.opportunities_found} opportunities`
      );
      await loadData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Scan failed";
      toast.error(msg);
    } finally {
      setScanning(false);
    }
  };

  const openOpps = opportunities.filter((o) => o.status === "open");
  const totalPnl = executions.reduce((sum, e) => sum + Number(e.realized_pnl), 0);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="glass border-b border-border/30 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-accent/10 border border-accent/20">
              <TrendingUp className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight font-mono text-accent">
                PREDICTION MARKET ARB
              </h1>
              <p className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase">
                Cross-Platform Arbitrage Scanner
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate("/")}
              className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              ← MEV Dashboard
            </button>
            <Button
              size="sm"
              onClick={runScan}
              disabled={scanning}
              className="font-mono text-xs"
            >
              <RefreshCw
                className={`h-3 w-3 mr-1 ${scanning ? "animate-spin" : ""}`}
              />
              {scanning ? "SCANNING..." : "SCAN NOW"}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-3 space-y-3 max-w-[1600px] mx-auto w-full">
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="glass border-border/30">
            <CardContent className="p-3">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">
                Open Opportunities
              </p>
              <p className="text-xl font-bold font-mono text-primary">
                {openOpps.length}
              </p>
            </CardContent>
          </Card>
          <Card className="glass border-border/30">
            <CardContent className="p-3">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">
                Best Spread
              </p>
              <p className="text-xl font-bold font-mono text-primary">
                {openOpps.length > 0
                  ? `${(openOpps[0].spread * 100).toFixed(1)}%`
                  : "—"}
              </p>
            </CardContent>
          </Card>
          <Card className="glass border-border/30">
            <CardContent className="p-3">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">
                Markets Tracked
              </p>
              <p className="text-xl font-bold font-mono text-foreground">
                {markets.size}
              </p>
            </CardContent>
          </Card>
          <Card className="glass border-border/30">
            <CardContent className="p-3">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">
                Executions
              </p>
              <p className="text-xl font-bold font-mono text-foreground">
                {executions.length}
              </p>
            </CardContent>
          </Card>
          <Card className="glass border-border/30">
            <CardContent className="p-3">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">
                Total P&L
              </p>
              <p
                className={`text-xl font-bold font-mono ${
                  totalPnl >= 0 ? "text-primary" : "text-destructive"
                }`}
              >
                ${totalPnl.toFixed(2)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Opportunities table */}
          <div className="lg:col-span-2">
            <Card className="glass border-border/30 h-full">
              <CardHeader className="pb-2 px-4 pt-3">
                <CardTitle className="text-sm font-mono flex items-center gap-2">
                  <Zap className="h-4 w-4 text-warning" />
                  LIVE OPPORTUNITIES
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2">
                {openOpps.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <AlertCircle className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-xs font-mono">No arb opportunities detected</p>
                    <p className="text-[10px] font-mono mt-1">
                      Click SCAN NOW to poll prediction markets
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[60vh] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/30">
                          <TableHead className="text-[10px] font-mono">MARKET</TableHead>
                          <TableHead className="text-[10px] font-mono">SIDE A</TableHead>
                          <TableHead className="text-[10px] font-mono">SIDE B</TableHead>
                          <TableHead className="text-[10px] font-mono">SPREAD</TableHead>
                          <TableHead className="text-[10px] font-mono">STATUS</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {openOpps.map((opp) => {
                          const mktA = markets.get(opp.market_a_id);
                          return (
                            <TableRow
                              key={opp.id}
                              className="border-border/20 hover:bg-secondary/30"
                            >
                          <TableCell className="text-xs font-mono max-w-[300px]">
                                <div className="truncate">{mktA?.question ?? opp.market_a_id.slice(0, 8)}</div>
                                {opp.market_a_id !== opp.market_b_id && (
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <Badge variant="outline" className="text-[8px] font-mono border-primary/30 text-primary px-1 py-0">
                                      {mktA?.platform?.toUpperCase() ?? "?"}
                                    </Badge>
                                    <ArrowRight className="h-2 w-2 text-muted-foreground" />
                                    <Badge variant="outline" className="text-[8px] font-mono border-accent/30 text-accent px-1 py-0">
                                      {markets.get(opp.market_b_id)?.platform?.toUpperCase() ?? "?"}
                                    </Badge>
                                    <span className="text-[8px] text-muted-foreground">CROSS-PLATFORM</span>
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs font-mono">
                                <span className="text-primary">
                                  {opp.side_a.toUpperCase()} @ $
                                  {Number(opp.price_a).toFixed(2)}
                                </span>
                              </TableCell>
                              <TableCell className="text-xs font-mono">
                                <span className="text-accent">
                                  {opp.side_b.toUpperCase()} @ $
                                  {Number(opp.price_b).toFixed(2)}
                                </span>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`font-mono text-[10px] ${
                                    opp.spread > 0.05
                                      ? "border-primary/40 text-primary bg-primary/5"
                                      : "border-warning/40 text-warning bg-warning/5"
                                  }`}
                                >
                                  {(opp.spread * 100).toFixed(1)}%
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className="font-mono text-[10px] border-success/40 text-success"
                                >
                                  {opp.status.toUpperCase()}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Execution history */}
          <div>
            <Card className="glass border-border/30 h-full">
              <CardHeader className="pb-2 px-4 pt-3">
                <CardTitle className="text-sm font-mono flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-primary" />
                  EXECUTION LOG
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2">
                {executions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <p className="text-xs font-mono">No executions yet</p>
                    <p className="text-[10px] font-mono mt-1">
                      Bot will auto-execute when opportunities appear
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[60vh] overflow-auto space-y-2">
                    {executions.map((exec) => (
                      <div
                        key={exec.id}
                        className="p-2 rounded bg-secondary/20 border border-border/20"
                      >
                        <div className="flex items-center justify-between">
                          <Badge
                            variant="outline"
                            className={`font-mono text-[10px] ${
                              exec.status === "filled"
                                ? "border-primary/40 text-primary"
                                : exec.status === "failed"
                                ? "border-destructive/40 text-destructive"
                                : "border-warning/40 text-warning"
                            }`}
                          >
                            {exec.status.toUpperCase()}
                          </Badge>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {new Date(exec.executed_at).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-xs font-mono text-muted-foreground">
                            ${Number(exec.amount_usd).toFixed(2)} deployed
                          </span>
                          <span
                            className={`text-xs font-bold font-mono ${
                              Number(exec.realized_pnl) >= 0
                                ? "text-primary"
                                : "text-destructive"
                            }`}
                          >
                            {Number(exec.realized_pnl) >= 0 ? "+" : ""}$
                            {Number(exec.realized_pnl).toFixed(2)}
                          </span>
                        </div>
                        {exec.error_message && (
                          <p className="text-[10px] font-mono text-destructive mt-1 truncate">
                            {exec.error_message}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Platform status */}
        <Card className="glass border-border/30">
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs font-mono text-muted-foreground">
                    Polymarket — {markets.size} markets
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-muted-foreground" />
                  <span className="text-xs font-mono text-muted-foreground">
                    Drift BET — Coming soon
                  </span>
                </div>
              </div>
              {lastScan && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  Last scan:{" "}
                  {new Date(lastScan).toLocaleTimeString()}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Arbitrage;
