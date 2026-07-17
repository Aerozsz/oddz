import Link from "next/link";
import {
  CategoryBars,
  MarketDetailCard,
  StatCard,
  TradersCard,
} from "@/features/overview/DashboardCards";
import { VolumeChart } from "@/features/overview/VolumeChart";
import { RankingsTable } from "@/features/markets/components/RankingsTable";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { listMovers } from "@/features/markets/queries";
import { getDashboard } from "@/features/overview/queries";
import { formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Overview",
  description: "Total volume, venue dominance, category breakdown, and top markets across every prediction market.",
};

const LABEL = "font-mono text-[10px] uppercase tracking-[0.14em] text-muted";

export default async function OverviewPage() {
  const [{ overview, series, changePct, featured }, movers] = await Promise.all([
    getDashboard(),
    listMovers(24, 12),
  ]);
  const up = changePct >= 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">
          Total prediction volume
        </h1>
        {series.length > 1 && (
          <span className={`font-mono text-[13px] ${up ? "text-accent" : "text-neg"}`}>
            {up ? "▲" : "▼"} {Math.abs(changePct * 100).toFixed(1)}% today
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total volume" value={formatUSD(overview.totalVolume)} href="/markets" />
        <StatCard label="Live markets" value={overview.totalMarkets.toLocaleString()} href="/markets" />
        <StatCard
          label="Top venue"
          value={overview.venues[0]?.venue ?? "—"}
          href="/overview"
        />
        <StatCard label="Venues" value={String(overview.venues.length)} href="/overview" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <VolumeChart series={series} />
        <CategoryBars categories={overview.categories} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TradersCard />
        <MarketDetailCard market={featured} />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className={LABEL}>Top markets · 24h</span>
        <Link href="/markets" className="text-xs text-accent hover:text-accent-hover">
          All markets →
        </Link>
      </div>
      <RankingsTable rows={movers} />

      <div className="mt-2 flex flex-col gap-3">
        <span className={LABEL}>Venue dominance</span>
        {overview.totalVolume > 0 && (
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-track">
            {overview.venues.map((v, i) => (
              <div
                key={v.venue}
                className="bg-accent"
                style={{ width: `${v.share * 100}%`, opacity: 1 - i * 0.18 }}
                title={`${v.venue}: ${(v.share * 100).toFixed(1)}%`}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {overview.venues.map((v) => (
            <Link key={v.venue} href={`/venues/${v.venue}`} className="flex items-center gap-2">
              <VenueBadge venue={v.venue} />
              <span className="font-mono text-xs text-muted">
                {(v.share * 100).toFixed(1)}% · {formatUSD(v.volume)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
