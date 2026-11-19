"use client";
import { useState } from "react";

type Series = { name: string; values: number[] };

// Categorical slots 1–4 from the validated reference palette (adjacent pairs pass CVD checks).
const COLORS = [1, 2, 3, 4].map((i) => `rgb(var(--c-series-${i}))`);
const MARKERS = ["circle", "square", "triangle", "diamond"] as const;

function Marker({ kind, x, y, color }: { kind: (typeof MARKERS)[number]; x: number; y: number; color: string }) {
  const common = { style: { fill: color, stroke: "rgb(var(--c-surface))" }, strokeWidth: 2 };
  if (kind === "circle") return <circle cx={x} cy={y} r={5} {...common} />;
  if (kind === "square") return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} rx={1.5} {...common} />;
  if (kind === "triangle") return <path d={`M${x},${y - 6} L${x + 5.5},${y + 4} L${x - 5.5},${y + 4}Z`} {...common} />;
  return <path d={`M${x},${y - 6} L${x + 6},${y} L${x},${y + 6} L${x - 6},${y}Z`} {...common} />;
}

export function LineChart({ title, years, series, yLabel, note }: { title: string; years: number[]; series: Series[]; yLabel: string; note?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 360, m = { t: 20, r: 92, b: 40, l: 46 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const yMax = 80;
  const x = (i: number) => m.l + (i / (years.length - 1)) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;
  const ticks = [0, 20, 40, 60, 80];

  // Direct labels at line ends, nudged apart to avoid collisions.
  const ends = series.map((s, i) => ({ i, y: y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 16) ends[k].y = ends[k - 1].y + 16;
  const labelY = new Map(ends.map((e) => [e.i, e.y]));

  return (
    <figure className="rounded-xl border border-slate-200 bg-surface p-4">
      <figcaption className="mb-2 text-center text-sm font-semibold text-ink">{title}</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. Line chart with ${series.length} countries.`}
          onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={m.l + iw} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? "rgb(var(--c-slate-400))" : "rgb(var(--c-slate-200))" }} strokeWidth={1} />
              <text x={m.l - 10} y={y(t)} dy="0.32em" textAnchor="end" fontSize="12" style={{ fill: "rgb(var(--c-ink-muted))" }}>{t}{yLabel}</text>
            </g>
          ))}
          {years.map((yr, i) => (
            <text key={yr} x={x(i)} y={H - m.b + 22} textAnchor="middle" fontSize="12" style={{ fill: "rgb(var(--c-ink-muted))" }}>{yr}</text>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} style={{ stroke: "rgb(var(--c-slate-400))" }} strokeDasharray="3 3" />}
          {series.map((s, si) => (
            <g key={s.name}>
              <path d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")} fill="none" style={{ stroke: COLORS[si] }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => <Marker key={i} kind={MARKERS[si]} x={x(i)} y={y(v)} color={COLORS[si]} />)}
              <text x={m.l + iw + 12} y={labelY.get(si)} dy="0.32em" fontSize="12" fontWeight={600} style={{ fill: "rgb(var(--c-ink-soft))" }}>{s.name}</text>
            </g>
          ))}
          {years.map((yr, i) => (
            <rect key={yr} x={x(i) - iw / (years.length - 1) / 2} y={m.t} width={iw / (years.length - 1)} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute top-2 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-xs shadow-card"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > years.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
            <p className="mb-1 font-semibold text-ink">{years[hover]}</p>
            {series.map((s, si) => (
              <p key={s.name} className="flex items-center gap-2 text-ink-soft">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS[si] }} />
                {s.name}<span className="ml-auto pl-3 font-semibold tabular-nums text-ink">{s.values[hover]}{yLabel}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-ink-soft" aria-label="Legend">
        {series.map((s, si) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden><Marker kind={MARKERS[si]} x={0} y={0} color={COLORS[si]} /></svg>{s.name}
          </li>
        ))}
      </ul>
      <details className="mt-3 text-xs text-ink-soft">
        <summary className="cursor-pointer select-none font-medium">View as table</summary>
        <table className="mt-2 w-full border-collapse text-left tabular-nums">
          <thead><tr><th className="border-b py-1 pr-2">Country</th>{years.map((yr) => <th key={yr} className="border-b py-1 pr-2">{yr}</th>)}</tr></thead>
          <tbody>{series.map((s) => <tr key={s.name}><td className="py-1 pr-2 font-medium">{s.name}</td>{s.values.map((v, i) => <td key={i} className="py-1 pr-2">{v}{yLabel}</td>)}</tr>)}</tbody>
        </table>
      </details>
      {note && <p className="mt-2 text-center text-[11px] text-ink-muted">{note}</p>}
    </figure>
  );
}
