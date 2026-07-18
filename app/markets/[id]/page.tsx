import Link from "next/link";
import { notFound } from "next/navigation";
import { PriceHistoryChart, type HistoryPoint } from "@/features/charts/PriceHistoryChart";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { getMarket, getMarketHistory } from "@/features/markets/queries";
import { getEvent } from "@/features/events/queries";
import { PayoutCalculator, type VenueQuote } from "@/features/payout/PayoutCalculator";
import { StarButton } from "@/features/watchlist/StarButton";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";
import { brand } from "@/lib/brand";
import { buildReferralUrl } from "@/lib/referrals";
import type { VenueSlug } from "@/lib/sources";
import { formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const market = await getMarket(decodeURIComponent(id));
  if (!market) return { title: "Market not found" };
  return {
    title: market.question,
    description: `Live odds for "${market.question}" on ${market.venueName}, with price history and cross-venue comparison.`,
    openGraph: {
      title: market.question,
      description: `Live prediction-market odds on ${market.venueName}. Track drift and relative value on ${brand.name}.`,
      type: "website",
    },
  };
}

export default async function MarketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const market = await getMarket(decodeURIComponent(id));
  if (!market) notFound();

  const history = await getMarketHistory(market.id, 24 * 7);
  const points: HistoryPoint[] = history
    .filter((p) => p.prices.length > 0)
    .map((p) => ({ takenAt: p.takenAt.toISOString(), yes: p.prices[0] }));

  const watchedIds = await getWid().then(getWatchedIds);
  const latestYes = points.at(-1)?.yes;
  const isBinary = market.outcomes.length === 2 && /yes/i.test(market.outcomes[0] ?? "");
  const primaryLabel = isBinary ? "YES" : (market.outcomes[0] ?? "Top outcome");

  // Build cross-venue quotes for the payout calculator. Prefer the event's
  // legs (all venues for the same question); fall back to this market alone.
  let quotes: VenueQuote[] = [];
  if (isBinary) {
    const event = market.eventId ? await getEvent(market.eventId) : null;
    if (event) {
      quotes = event.legs
        .filter((l) => l.yes !== null)
        .map((l) => ({
          venue: l.venue,
          venueName: l.venueName,
          yes: l.yes as number,
          sourceUrl: l.sourceUrl,
        }));
    }
    if (quotes.length === 0 && latestYes !== undefined) {
      quotes = [
        { venue: market.venue, venueName: market.venueName, yes: latestYes, sourceUrl: market.sourceUrl },
      ];
    }
  }
  const tradeUrl = buildReferralUrl({
    venue: market.venue as VenueSlug,
    slug: market.slug,
    externalId: market.externalId,
    sourceUrl: market.sourceUrl,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/markets" className="link self-start text-xs text-muted hover:text-fg">
          ← Back to markets
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <StarButton
              marketId={market.id}
              initialWatched={watchedIds.has(market.id)}
              className="mt-1"
            />
            <h1 className="text-2xl font-semibold tracking-tight">{market.question}</h1>
          </div>
          <a
            href={tradeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-bg transition-transform hover:scale-[1.04] hover:bg-accent-hover"
          >
            Trade on {market.venueName} ↗
          </a>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <VenueBadge venue={market.venue} name={market.venueName} />
          {market.category && <span>· {market.category}</span>}
          {market.eventId && (
            <Link
              href={`/events/${encodeURIComponent(market.eventId)}`}
              className="text-emerald-400 hover:text-emerald-300"
            >
              · Compare venues →
            </Link>
          )}
          {latestYes !== undefined && (
            <span className="ml-auto truncate font-mono text-emerald-300" title={primaryLabel}>
              {primaryLabel} {formatPct(latestYes)}
            </span>
          )}
        </div>
      </div>

      {quotes.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-200">What you&apos;d win</h2>
          <PayoutCalculator quotes={quotes} outcomes={market.outcomes} />
        </div>
      )}

      <PriceHistoryChart data={points} label={primaryLabel} />

      {market.description && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-zinc-300">
          <h2 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
            Description
          </h2>
          <p className="whitespace-pre-wrap">{market.description}</p>
        </div>
      )}
    </div>
  );
}
