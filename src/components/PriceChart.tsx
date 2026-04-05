import { PriceCandle } from "@/lib/mockData";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChart3 } from "lucide-react";
import { useState } from "react";

interface PriceChartProps {
  candles: PriceCandle[];
}

export const PriceChart = ({ candles }: PriceChartProps) => {
  const [interval, setInterval] = useState<"5m" | "15m">("5m");

  const displayCandles = interval === "15m"
    ? candles.filter((_, i) => i % 3 === 0)
    : candles;

  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-mono font-semibold text-primary text-glow-primary">
            SOL/USDC PRICE
          </h2>
        </div>
        <div className="flex gap-1">
          {(["5m", "15m"] as const).map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all ${
                interval === iv
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={displayCandles}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: "hsl(220 10% 45%)", fontFamily: "JetBrains Mono" }}
              axisLine={{ stroke: "hsl(220 15% 14%)" }}
              tickLine={false}
            />
            <YAxis
              domain={["dataMin - 2", "dataMax + 2"]}
              tick={{ fontSize: 9, fill: "hsl(220 10% 45%)", fontFamily: "JetBrains Mono" }}
              axisLine={false}
              tickLine={false}
              width={45}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(220 18% 7%)",
                border: "1px solid hsl(220 15% 14%)",
                borderRadius: "6px",
                fontSize: "11px",
                fontFamily: "JetBrains Mono",
                color: "hsl(180 10% 88%)",
              }}
            />
            <Bar dataKey="close" radius={[2, 2, 0, 0]}>
              {displayCandles.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.close >= entry.open ? "hsl(160 100% 45%)" : "hsl(0 72% 51%)"}
                  fillOpacity={0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
