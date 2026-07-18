import Link from "next/link";
import { formatPct } from "@/lib/utils";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import type { DivergenceRow } from "../queries";

// Per-venue marker colour on the strip. Neutral by default; the spread band
// carries the green/red semantics.
const VENUE_DOT: Record<string, string> = {
  polymarket: "#6AA9FF",
  kalshi: "rgb(var(--c-accent))",
  manifold: "#E7B740",
  metaculus: "#B98BEA",
};

export function DivergenceTable({ rows }: { rows: DivergenceRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
        No matched events across venues yet. The matcher needs at least two venues
        listing the same question — once the snapshot worker has run a few times
        and the canonical-key matcher reconciles, divergences appear here.
      </div>
    );
  }

  // z-score of each spread relative to the population of spreads on view.
  const spreads = rows.map((r) => r.spread);
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const sd =
    Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length) || 1;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const ys = r.legs.map((l) => l.yes);
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        const z = (r.spread - mean) / sd;
        const wide = r.spread >= 0.1; // sources disagree by >10pp
        return (
          <div
            key={r.eventId}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/events/${encodeURIComponent(r.eventId)}`}
                className="text-sm text-fg hover:text-white"
              >
                {r.title}
                {r.category && <span className="ml-2 text-xs text-muted">{r.category}</span>}
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="rounded px-2 py-0.5 font-mono text-xs tabular-nums"
                  style={{
                    backgroundColor: wide ? "rgb(var(--c-neg) / 0.15)" : "rgb(var(--c-track))",
                    color: wide ? "rgb(var(--c-neg))" : "rgb(var(--c-fg))",
                  }}
                >
                  {(r.spread * 100).toFixed(1)}pp
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted" title="z-score vs other divergences">
                  z {z >= 0 ? "+" : ""}
                  {z.toFixed(1)}
                </span>
              </div>
            </div>

            {/* 0–100% strip with a spread band and per-venue markers */}
            <div className="relative h-6">
              <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-track" />
              <div
                className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                style={{
                  left: `${lo * 100}%`,
                  width: `${Math.max(1, (hi - lo) * 100)}%`,
                  backgroundColor: wide ? "rgb(var(--c-neg))" : "rgb(var(--c-accent))",
                }}
              />
              {r.legs.map((leg) => (
                <span
                  key={leg.marketId}
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[rgb(var(--c-surface))]"
                  style={{
                    left: `${leg.yes * 100}%`,
                    backgroundColor: VENUE_DOT[leg.venue] ?? "rgb(var(--c-muted))",
                  }}
                  title={`${leg.venue}: ${formatPct(leg.yes)}`}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {r.legs
                .slice()
                .sort((a, b) => b.yes - a.yes)
                .map((leg) => (
                  <Link
                    key={leg.marketId}
                    href={`/markets/${encodeURIComponent(leg.marketId)}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1 hover:border-[rgb(var(--c-accent))]/40"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: VENUE_DOT[leg.venue] ?? "rgb(var(--c-muted))" }}
                    />
                    <VenueBadge venue={leg.venue} />
                    <span className="font-mono text-xs tabular-nums text-fg">
                      {formatPct(leg.yes)}
                    </span>
                  </Link>
                ))}
            </div>
          </div>
        );
      })}
      <p className="mt-1 text-xs text-muted">
        The band spans each event&apos;s cheapest to priciest YES. A high z-score means the gap is
        unusually wide vs other cross-venue pairs — the classic mean-reversion setup.
      </p>
    </div>
  );
}
