"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface HistoryPoint {
  takenAt: string;
  yes: number;
}

export function PriceHistoryChart({ data, label = "YES" }: { data: HistoryPoint[]; label?: string }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-zinc-800 bg-zinc-900/40 text-sm text-zinc-500">
        No history yet — needs at least two snapshots.
      </div>
    );
  }

  return (
    <div className="h-64 w-full rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="takenAt"
            tickFormatter={(t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
            formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, label]}
          />
          <Line type="monotone" dataKey="yes" stroke="#34d399" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
