import { VolumeBucket } from "@/lib/mockData";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChart3 } from "lucide-react";

interface VolumeChartProps {
  buckets: VolumeBucket[];
}

export const VolumeChart = ({ buckets }: VolumeChartProps) => {
  const maxVol = Math.max(...buckets.map((b) => b.volume), 1);

  return (
    <div className="glass rounded-xl overflow-hidden gradient-border">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
          </div>
          <h2 className="text-sm font-mono font-semibold text-primary">
            VOLUME
          </h2>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/60 tracking-wider">5MIN</span>
      </div>

      <div className="p-4 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: "hsl(225 12% 42%)", fontFamily: "JetBrains Mono" }}
              axisLine={{ stroke: "hsl(225 15% 12%)" }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 9, fill: "hsl(225 12% 42%)", fontFamily: "JetBrains Mono" }}
              axisLine={false}
              tickLine={false}
              width={50}
              tickFormatter={(v) => (v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : `${(v / 1000).toFixed(0)}K`)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(225 20% 6%)",
                border: "1px solid hsl(225 15% 15%)",
                borderRadius: "10px",
                fontSize: "11px",
                fontFamily: "JetBrains Mono",
                color: "hsl(210 20% 90%)",
                boxShadow: "0 8px 32px hsl(0 0% 0% / 0.4)",
              }}
              formatter={(value: number) => [`$${value.toLocaleString()}`, "Volume"]}
              labelFormatter={(label) => `Time: ${label}`}
            />
            <Bar dataKey="volume" radius={[4, 4, 0, 0]}>
              {buckets.map((entry, i) => {
                const intensity = entry.volume / maxVol;
                return (
                  <Cell
                    key={i}
                    fill={intensity > 0.7 ? "hsl(155 90% 48%)" : "hsl(155 70% 40%)"}
                    fillOpacity={0.4 + intensity * 0.6}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
