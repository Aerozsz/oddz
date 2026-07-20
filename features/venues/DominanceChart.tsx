"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DominancePoint } from "./queries";
import { formatUSD } from "@/lib/utils";

// Same muted per-venue palette as the event overlay chart.
const VENUE_COLORS: Record<string, string> = {
  polymarket: "#7FA6D9",
  kalshi: "rgb(var(--c-accent))",
  manifold: "#D9B45C",
  metaculus: "#B48FD9",
};

export function DominanceChart({
  points,
  venues,
}: {
  points: DominancePoint[];
  venues: string[];
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border border-border bg-surface text-sm text-muted">
        Dominance fills in as daily history accumulates.
      </div>
    );
  }

  return (
    <div className="h-56 w-full rounded-lg border border-border bg-surface p-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} stackOffset="expand">
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) =>
              new Date(d + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric" })
            }
            stroke="rgb(var(--c-muted) / 0.7)"
            fontSize={11}
          />
          <YAxis
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            stroke="rgb(var(--c-muted) / 0.7)"
            fontSize={11}
            width={38}
          />
          <Tooltip
            contentStyle={{
              background: "rgb(var(--c-surface))",
              border: "1px solid rgb(var(--c-border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: number, name: string) => [formatUSD(v), name]}
          />
          {venues.map((v) => (
            <Area
              key={v}
              type="monotone"
              dataKey={v}
              stackId="1"
              stroke={VENUE_COLORS[v] ?? "rgb(var(--c-muted))"}
              fill={VENUE_COLORS[v] ?? "rgb(var(--c-muted))"}
              fillOpacity={0.35}
              strokeWidth={1.5}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
