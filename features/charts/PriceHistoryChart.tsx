"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface HistoryPoint {
  takenAt: string;
  yes: number;
}

export function PriceHistoryChart({ data, label = "YES" }: { data: HistoryPoint[]; label?: string }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-border bg-surface text-sm text-zinc-500">
        No history yet — needs at least two snapshots.
      </div>
    );
  }

  return (
    <div className="h-64 w-full rounded-lg border border-border bg-surface p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="takenAt"
            tickFormatter={(t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            stroke="rgb(var(--c-muted) / 0.7)"
            fontSize={11}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
            stroke="rgb(var(--c-muted) / 0.7)"
            fontSize={11}
            width={40}
          />
          <Tooltip
            contentStyle={{ background: "rgb(var(--c-surface))", border: "1px solid rgb(var(--c-border))", borderRadius: 8, fontSize: 12 }}
            labelFormatter={(t: string) => new Date(t).toLocaleString()}
            formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, label]}
          />
          <Line type="monotone" dataKey="yes" stroke="rgb(var(--c-accent))" strokeWidth={2.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
