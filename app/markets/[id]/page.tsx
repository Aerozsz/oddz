import Link from "next/link";
import { notFound } from "next/navigation";
import { PriceHistoryChart, type HistoryPoint } from "@/features/charts/PriceHistoryChart";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { getMarket, getMarketHistory } from "@/features/markets/queries";
import { buildReferralUrl } from "@/lib/referrals";
import type { VenueSlug } from "@/lib/sources";
import { formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function MarketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const market = await getMarket(decodeURIComponent(id));
  if (!market) notFound();

  const history = await getMarketHistory(market.id, 24 * 7);
  const points: HistoryPoint[] = history
    .filter((p) => p.prices.length > 0)
    .map((p) => ({ takenAt: p.takenAt.toISOString(), yes: p.prices[0] }));

  const latestYes = points.at(-1)?.yes;
  const tradeUrl = buildReferralUrl({
    venue: market.venue as VenueSlug,
    slug: market.slug,
    externalId: market.externalId,
    sourceUrl: market.sourceUrl,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/markets" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Back to markets
        </Link>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{market.question}</h1>
          <a
            href={tradeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-emerald-400"
          >
            Trade on {market.venueName} ↗
          </a>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <VenueBadge venue={market.venue} name={market.venueName} />
          {market.category && <span>· {market.category}</span>}
          {latestYes !== undefined && (
            <span className="ml-auto font-mono text-emerald-300">YES {formatPct(latestYes)}</span>
          )}
        </div>
      </div>

      <PriceHistoryChart data={points} />

      {market.description && (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-300">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Description
          </h2>
          <p className="whitespace-pre-wrap">{market.description}</p>
        </div>
      )}
    </div>
  );
}
