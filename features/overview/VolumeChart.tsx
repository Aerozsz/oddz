"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import type { VolumePoint } from "./queries";
import { cn, formatUSD } from "@/lib/utils";

const RANGES = [
  { key: "24H", hours: 24 },
  { key: "7D", hours: 24 * 7 },
  { key: "30D", hours: 24 * 30 },
] as const;

export function VolumeChart({ series }: { series: VolumePoint[] }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("24H");

  const data = useMemo(() => {
    const hours = RANGES.find((r) => r.key === range)!.hours;
    const cutoff = Date.now() - hours * 3600_000;
    return series.filter((p) => new Date(p.t).getTime() >= cutoff);
  }, [series, range]);

  const latest = series.at(-1)?.total ?? 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center justify-between">
        <span className="font-mono text-2xl font-semibold text-fg">{formatUSD(latest)}</span>
        <div className="flex gap-1.5 font-mono text-[10px]">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                "rounded-[5px] px-2 py-[3px] transition-colors",
                range === r.key
                  ? "bg-accent text-bg"
                  : "border border-border text-muted hover:text-fg",
              )}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2.5 h-[150px] w-full">
        {data.length < 2 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            Not enough history yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--c-accent))" stopOpacity={0.16} />
                  <stop offset="100%" stopColor="rgb(var(--c-accent))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Tooltip
                contentStyle={{
                  background: "rgb(var(--c-surface))",
                  border: "1px solid rgb(var(--c-border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(t: string) => new Date(t).toLocaleString()}
                formatter={(v: number) => [formatUSD(v), "Volume"]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="rgb(var(--c-accent))"
                strokeWidth={2.5}
                fill="url(#volFill)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
