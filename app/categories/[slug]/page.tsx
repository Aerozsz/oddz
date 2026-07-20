import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { getSparklines, listMarkets, listMovers } from "@/features/markets/queries";
import { getOverview } from "@/features/overview/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const name = decodeURIComponent(slug);
  return { title: name.charAt(0).toUpperCase() + name.slice(1) };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const category = decodeURIComponent(slug).toLowerCase();

  const [overview, rows, allMovers] = await Promise.all([
    getOverview(),
    listMarkets({ category, sort: "volume", limit: 60 }),
    listMovers(24, 200).catch(() => []),
  ]);
  const catMovers = allMovers
    .filter((m) => (m.category ?? "").toLowerCase() === category)
    .slice(0, 6);
  const stat = overview.categories.find((c) => c.category === category);
  const sparklines = await getSparklines(rows.map((r) => r.id), 24);
  const watchedIds = await getWid().then(getWatchedIds);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={category.charAt(0).toUpperCase() + category.slice(1)}
        context={<><LiveDot /> {String(stat?.markets ?? rows.length)} markets · {formatUSD(stat?.volume ?? 0)}</>}
        blurb={<>Every {category} market, across all venues.</>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
        <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />

        <aside className="flex flex-col gap-2">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Moving in {category} · 24h
          </h2>
          <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
            {catMovers.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted">No moves in this window.</div>
            ) : (
              catMovers.map((m) => (
                <Link
                  key={m.id}
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="tap flex flex-col gap-1 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-[13px] leading-snug text-fg">{m.question}</span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-sm font-semibold tabular-nums",
                        m.delta >= 0 ? "text-accent" : "text-neg",
                      )}
                    >
                      {m.delta >= 0 ? "+" : ""}
                      {(m.delta * 100).toFixed(1)}pp
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <VenueBadge venue={m.venue} />
                    <span className="font-mono text-[10px] tabular-nums text-muted">
                      {formatPct(m.yesThen)} → {formatPct(m.yesNow)}
                    </span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </aside>
      </div>

      <Link href="/overview" className="text-xs text-emerald-400 hover:text-emerald-300">
        ← All categories
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
    </div>
  );
}
