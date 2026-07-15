import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots, venues } from "@/lib/db/schema";
import type { VenueSlug } from "@/lib/sources";

export interface MarketRow {
  id: string;
  venue: string;
  venueName: string;
  slug: string;
  question: string;
  category: string | null;
  outcomes: string[];
  prices: number[];
  volume: number | null;
  liquidity: number | null;
  endsAt: Date | null;
  sourceUrl: string;
  lastSeenAt: Date;
}

export type MarketSort = "volume" | "liquidity" | "updated";

export interface ListMarketsParams {
  q?: string;
  venue?: VenueSlug;
  category?: string;
  sort?: MarketSort;
  limit?: number;
  offset?: number;
}

export async function listMarkets(params: ListMarketsParams = {}): Promise<MarketRow[]> {
  const { q, venue, category, sort = "volume", limit = 50, offset = 0 } = params;

  // Subquery: most recent snapshot per market.
  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("max_taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  const filters = [eq(markets.closed, 0)];
  if (venue) filters.push(eq(markets.venueSlug, venue));
  if (category) filters.push(sql`lower(${markets.category}) = ${category.toLowerCase()}`);
  if (q && q.trim()) {
    const needle = `%${q.trim()}%`;
    const f = or(ilike(markets.question, needle), ilike(markets.category, needle));
    if (f) filters.push(f);
  }

  const orderBy =
    sort === "liquidity"
      ? [desc(priceSnapshots.liquidity), desc(priceSnapshots.volume)]
      : sort === "updated"
        ? [desc(markets.lastSeenAt), desc(priceSnapshots.volume)]
        : [desc(priceSnapshots.volume), desc(markets.lastSeenAt)];

  const rows = await db
    .select({
      id: markets.id,
      venue: markets.venueSlug,
      venueName: venues.name,
      slug: markets.slug,
      question: markets.question,
      category: markets.category,
      outcomes: markets.outcomes,
      prices: priceSnapshots.prices,
      volume: priceSnapshots.volume,
      liquidity: priceSnapshots.liquidity,
      endsAt: markets.endsAt,
      sourceUrl: markets.sourceUrl,
      lastSeenAt: markets.lastSeenAt,
    })
    .from(markets)
    .innerJoin(venues, eq(venues.slug, markets.venueSlug))
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  return rows;
}

/** Top categories among open markets, normalized to lowercase, by count. */
export async function topCategories(limit = 8): Promise<{ category: string; count: number }[]> {
  const rows = await db
    .select({
      category: sql<string>`lower(${markets.category})`,
      count: sql<number>`count(*)::int`,
    })
    .from(markets)
    .where(and(eq(markets.closed, 0), sql`${markets.category} IS NOT NULL`))
    .groupBy(sql`lower(${markets.category})`)
    .orderBy(sql`count(*) DESC`)
    .limit(limit);
  return rows.filter((r) => r.category);
}

export async function getMarket(id: string) {
  const [row] = await db
    .select({
      id: markets.id,
      venue: markets.venueSlug,
      venueName: venues.name,
      slug: markets.slug,
      externalId: markets.externalId,
      question: markets.question,
      description: markets.description,
      category: markets.category,
      outcomes: markets.outcomes,
      sourceUrl: markets.sourceUrl,
      endsAt: markets.endsAt,
      eventId: markets.eventId,
      lastSeenAt: markets.lastSeenAt,
    })
    .from(markets)
    .innerJoin(venues, eq(venues.slug, markets.venueSlug))
    .where(eq(markets.id, id))
    .limit(1);
  return row ?? null;
}

export async function getMarketHistory(marketId: string, sinceHours = 24 * 7) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  return db
    .select({
      takenAt: priceSnapshots.takenAt,
      prices: priceSnapshots.prices,
      volume: priceSnapshots.volume,
    })
    .from(priceSnapshots)
    .where(and(eq(priceSnapshots.marketId, marketId), lt(priceSnapshots.takenAt, new Date()), sql`${priceSnapshots.takenAt} >= ${since}`))
    .orderBy(priceSnapshots.takenAt);
}

/**
 * Last `points` YES prices for a set of markets, oldest-first, in one
 * query (row_number window over the snapshot history). Powers the
 * sparkline column without an N+1 per row.
 */
export async function getSparklines(
  marketIds: string[],
  points = 24,
): Promise<Map<string, number[]>> {
  if (marketIds.length === 0) return new Map();

  const rows = await db.execute<{ market_id: string; yes: number }>(sql`
    SELECT market_id, (prices->>0)::float AS yes
    FROM (
      SELECT market_id, prices, taken_at,
             row_number() OVER (PARTITION BY market_id ORDER BY taken_at DESC) AS rn
      FROM price_snapshots
      WHERE market_id IN (${sql.join(
        marketIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    ) ranked
    WHERE rn <= ${points}
    ORDER BY market_id, taken_at ASC
  `);

  const result = new Map<string, number[]>();
  for (const r of rows.rows) {
    if (!Number.isFinite(r.yes)) continue;
    const arr = result.get(r.market_id);
    if (arr) arr.push(r.yes);
    else result.set(r.market_id, [r.yes]);
  }
  return result;
}

export async function getDataAge(): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<Date>`max(${markets.lastSeenAt})` })
    .from(markets);
  return row?.latest ?? null;
}
