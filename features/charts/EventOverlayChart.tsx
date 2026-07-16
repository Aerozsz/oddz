"use client";

import { Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OverlayPoint } from "@/features/events/queries";

const VENUE_COLORS: Record<string, string> = {
  polymarket: "#60a5fa",
  kalshi: "#34d399",
  manifold: "#fbbf24",
  metaculus: "#c084fc",
};

export function EventOverlayChart({ data, venues }: { data: OverlayPoint[]; venues: string[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded border border-zinc-800 bg-zinc-900/40 text-sm text-zinc-500">
        No history yet — needs at least one snapshot per venue.
      </div>
    );
  }

  return (
    <div className="h-72 w-full rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="t"
            tickFormatter={(t: string) =>
              new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }
            stroke="#52525b"
            fontSize={11}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            stroke="#52525b"
            fontSize={11}
            width={40}
          />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 12 }}
            labelFormatter={(t: string) => new Date(t).toLocaleString()}
            formatter={(v: number, name: string) => [`${(v * 100).toFixed(1)}%`, name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {venues.map((v) => (
            <Line
              key={v}
              type="monotone"
              dataKey={v}
              stroke={VENUE_COLORS[v] ?? "#a1a1aa"}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
