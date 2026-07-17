import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { getSparklines, listMarkets } from "@/features/markets/queries";
import { getOverview } from "@/features/overview/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";
import type { VenueSlug } from "@/lib/sources";
import { formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

const VENUES: Record<string, { name: string; home: string }> = {
  polymarket: { name: "Polymarket", home: "https://polymarket.com" },
  kalshi: { name: "Kalshi", home: "https://kalshi.com" },
  manifold: { name: "Manifold", home: "https://manifold.markets" },
  metaculus: { name: "Metaculus", home: "https://www.metaculus.com" },
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const v = VENUES[slug];
  return { title: v ? `${v.name}` : "Venue" };
}

export default async function VenuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = VENUES[slug];
  if (!meta) notFound();

  const [overview, rows] = await Promise.all([
    getOverview(),
    listMarkets({ venue: slug as VenueSlug, sort: "volume", limit: 50 }),
  ]);
  const stat = overview.venues.find((v) => v.venue === slug);
  const sparklines = await getSparklines(rows.map((r) => r.id), 24);
  const watchedIds = await getWid().then(getWatchedIds);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{meta.name}</h1>
          <p className="text-sm text-zinc-500">Live markets and volume on {meta.name}.</p>
        </div>
        <a
          href={meta.home}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs hover:border-zinc-500"
        >
          Visit {meta.name} ↗
        </a>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Volume" value={formatUSD(stat?.volume ?? 0)} />
        <Stat label="Live markets" value={String(stat?.markets ?? 0)} />
        <Stat
          label="Share of total"
          value={stat ? `${(stat.share * 100).toFixed(1)}%` : "—"}
        />
      </div>

      <h2 className="mt-2 text-sm font-medium text-zinc-200">Top markets by volume</h2>
      <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />

      <Link href="/overview" className="text-xs text-emerald-400 hover:text-emerald-300">
        ← All venues
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
