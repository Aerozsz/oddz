import { CategoryChips } from "@/features/markets/components/CategoryChips";
import { Filters } from "@/features/markets/components/Filters";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { PageNav } from "@/features/markets/components/PageNav";
import {
  getDataAge,
  getSparklines,
  listMarkets,
  topCategories,
  type MarketSort,
} from "@/features/markets/queries";
import type { VenueSlug } from "@/lib/sources";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

const PAGE_SIZE = 100;
const VENUES: VenueSlug[] = ["polymarket", "kalshi", "manifold", "metaculus"];
const SORTS: MarketSort[] = ["volume", "liquidity", "updated"];

function isVenue(s: string | undefined): s is VenueSlug {
  return !!s && (VENUES as string[]).includes(s);
}

function isSort(s: string | undefined): s is MarketSort {
  return !!s && (SORTS as string[]).includes(s);
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; venue?: string; cat?: string; sort?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const venue = isVenue(sp.venue) ? sp.venue : undefined;
  const sort = isSort(sp.sort) ? sp.sort : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  // Fetch one extra row to know whether a next page exists.
  const [rows, lastSeen, categories] = await Promise.all([
    listMarkets({
      q: sp.q,
      venue,
      category: sp.cat,
      sort,
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getDataAge(),
    topCategories(8),
  ]);
  const hasNext = rows.length > PAGE_SIZE;
  const visible = hasNext ? rows.slice(0, PAGE_SIZE) : rows;
  const sparklines = await getSparklines(
    visible.map((r) => r.id),
    24,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-zinc-500">
            {visible.length}
            {hasNext ? "+" : ""} live markets {lastSeen && `· refreshed ${timeAgo(lastSeen)}`}
          </p>
        </div>
      </div>
      <Filters />
      <CategoryChips categories={categories} active={sp.cat?.toLowerCase()} searchParams={sp} />
      <MarketTable rows={visible} sparklines={sparklines} />
      <PageNav page={page} hasNext={hasNext} searchParams={sp} />
    </div>
  );
}
