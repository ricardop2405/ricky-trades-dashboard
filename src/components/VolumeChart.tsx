import { VolumeBucket } from "@/lib/mockData";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChart3 } from "lucide-react";

interface VolumeChartProps {
  buckets: VolumeBucket[];
}

export const VolumeChart = ({ buckets }: VolumeChartProps) => {
  const maxVol = Math.max(...buckets.map((b) => b.volume), 1);

  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-mono font-semibold text-primary text-glow-primary">
            TRADE VOLUME
          </h2>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">5min buckets</span>
      </div>

      <div className="p-4 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: "hsl(220 10% 45%)", fontFamily: "JetBrains Mono" }}
              axisLine={{ stroke: "hsl(220 15% 14%)" }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 9, fill: "hsl(220 10% 45%)", fontFamily: "JetBrains Mono" }}
              axisLine={false}
              tickLine={false}
              width={50}
              tickFormatter={(v) => (v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : `${(v / 1000).toFixed(0)}K`)}
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
              formatter={(value: number) => [`$${value.toLocaleString()}`, "Volume"]}
              labelFormatter={(label) => `Time: ${label}`}
            />
            <Bar dataKey="volume" radius={[2, 2, 0, 0]}>
              {buckets.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.volume > maxVol * 0.7 ? "hsl(160 100% 45%)" : "hsl(var(--primary))"}
                  fillOpacity={0.6 + (entry.volume / maxVol) * 0.4}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
