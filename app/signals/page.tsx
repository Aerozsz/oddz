import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { listArbitrage } from "@/features/arbitrage/queries";
import { listDivergences } from "@/features/divergence/queries";
import { listMovers } from "@/features/markets/queries";
import { listYields } from "@/features/yields/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Signals",
  description: "Every live edge on one screen: arbitrage, divergence, yields, movers.",
};

function Module({
  label,
  href,
  children,
  empty,
  count,
}: {
  label: string;
  href: string;
  children: React.ReactNode;
  empty: boolean;
  count: number;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          {label}
          <span className="text-muted/60">({count})</span>
        </h2>
        <Link href={href as never} className="link font-mono text-[11px] text-accent">
          all →
        </Link>
      </div>
      <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {empty ? (
          <div className="p-4 text-center text-xs text-muted">Nothing live right now.</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export default async function SignalsPage() {
  const [arbs, divs, yields, movers] = await Promise.all([
    listArbitrage(0.005, 5).catch(() => []),
    listDivergences(5).catch(() => []),
    listYields({ maxDays: 30, limit: 5 }).catch(() => []),
    listMovers(24, 10).catch(() => []),
  ]);
  const topMovers = movers.slice(0, 5);
  const liveCount = arbs.length + divs.length + yields.length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Signals"
        context={<><LiveDot /> {liveCount} live edges</>}
        blurb={<>Every live edge on one screen — the best of each signal, ranked. Click through for
          the full list and the math behind it.</>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Module label="Arbitrage" href="/arbitrage" empty={arbs.length === 0} count={arbs.length}>
          {arbs.map((a) => (
            <Link
              key={a.eventId}
              href={`/events/${encodeURIComponent(a.eventId)}`}
              className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
            >
              <span className="line-clamp-1 text-[13px] text-fg">{a.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                <VenueBadge venue={a.buyYes.venue} />
                <span className="text-muted">+</span>
                <VenueBadge venue={a.buyNo.venue} />
                <span className="w-14 text-right font-mono text-sm font-semibold tabular-nums text-accent">
                  +{formatPct(a.edge)}
                </span>
              </span>
            </Link>
          ))}
        </Module>

        <Module label="Best yields ≤30d" href="/yields" empty={yields.length === 0} count={yields.length}>
          {yields.map((r) => (
            <Link
              key={r.id}
              href={`/markets/${encodeURIComponent(r.id)}`}
              className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
            >
              <span className="line-clamp-1 text-[13px] text-fg">{r.question}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                    r.side === "YES" ? "bg-accent/15 text-accent" : "bg-neg/15 text-neg",
                  )}
                >
                  {r.side} {formatPct(r.price)}
                </span>
                <span className="w-14 text-right font-mono text-sm font-semibold tabular-nums text-accent">
                  {r.apr >= 10 ? `${r.apr.toFixed(0)}×` : formatPct(r.apr)}
                </span>
              </span>
            </Link>
          ))}
        </Module>

        <Module label="Cross-venue gaps" href="/divergence" empty={divs.length === 0} count={divs.length}>
          {divs.map((d) => (
            <Link
              key={d.eventId}
              href={`/events/${encodeURIComponent(d.eventId)}`}
              className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
            >
              <span className="line-clamp-1 text-[13px] text-fg">{d.title}</span>
              <span
                className="w-16 shrink-0 text-right font-mono text-sm font-semibold tabular-nums"
                style={{ color: d.spread > 0.1 ? "rgb(var(--c-neg))" : "rgb(var(--c-fg))" }}
              >
                {(d.spread * 100).toFixed(1)}pp
              </span>
            </Link>
          ))}
        </Module>

        <Module label="Biggest movers 24h" href="/movers" empty={topMovers.length === 0} count={topMovers.length}>
          {topMovers.map((m) => (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
            >
              <span className="line-clamp-1 text-[13px] text-fg">{m.question}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {formatPct(m.yesThen)} → {formatPct(m.yesNow)}
                </span>
                <span
                  className={cn(
                    "w-14 text-right font-mono text-sm font-semibold tabular-nums",
                    m.delta >= 0 ? "text-accent" : "text-neg",
                  )}
                >
                  {m.delta >= 0 ? "+" : ""}
                  {(m.delta * 100).toFixed(1)}pp
                </span>
              </span>
            </Link>
          ))}
        </Module>
      </div>

      <p className="text-xs text-muted">
        Deeper cuts:{" "}
        <Link href="/consensus" className="link text-fg-dim">Consensus</Link> ·{" "}
        <Link href="/leadlag" className="link text-fg-dim">Lead / lag</Link> ·{" "}
        <Link href="/correlations" className="link text-fg-dim">Correlations</Link> ·{" "}
        <Link href="/divergence" className="link text-fg-dim">Divergence</Link> — these depend on
        cross-venue matching and history depth, and graduate to the sidebar once they carry data.
      </p>
    </div>
  );
}
