import { Filters } from "@/features/markets/components/Filters";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { getDataAge, listMarkets } from "@/features/markets/queries";
import type { VenueSlug } from "@/lib/sources";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

const VENUES: VenueSlug[] = ["polymarket", "kalshi", "manifold", "metaculus"];

function isVenue(s: string | undefined): s is VenueSlug {
  return !!s && (VENUES as string[]).includes(s);
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; venue?: string }>;
}) {
  const sp = await searchParams;
  const venue = isVenue(sp.venue) ? sp.venue : undefined;
  const [rows, lastSeen] = await Promise.all([
    listMarkets({ q: sp.q, venue, limit: 100 }),
    getDataAge(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-zinc-500">
            {rows.length} live markets {lastSeen && `· refreshed ${timeAgo(lastSeen)}`}
          </p>
        </div>
      </div>
      <Filters />
      <MarketTable rows={rows} />
    </div>
  );
}
