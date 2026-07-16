import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
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
  ids?: string[];
  limit?: number;
  offset?: number;
}

export async function listMarkets(params: ListMarketsParams = {}): Promise<MarketRow[]> {
  const { q, venue, category, sort = "volume", ids, limit = 50, offset = 0 } = params;
  if (ids !== undefined && ids.length === 0) return [];

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
  if (ids) filters.push(inArray(markets.id, ids));
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

export interface MoverRow {
  id: string;
  venue: string;
  venueName: string;
  question: string;
  category: string | null;
  sourceUrl: string;
  yesNow: number;
  yesThen: number;
  delta: number;
  volume: number | null;
}

/**
 * Biggest YES moves over the lookback window: latest snapshot vs the
 * earliest snapshot within the window, per market, ranked by |delta|.
 */
export async function listMovers(hours = 24, limit = 30): Promise<MoverRow[]> {
  const rows = await db.execute<{
    id: string;
    venue: string;
    venue_name: string;
    question: string;
    category: string | null;
    source_url: string;
    yes_now: number;
    yes_then: number;
    volume: number | null;
  }>(sql`
    WITH windowed AS (
      SELECT market_id,
             (prices->>0)::float AS yes,
             volume,
             row_number() OVER (PARTITION BY market_id ORDER BY taken_at DESC) AS rn_desc,
             row_number() OVER (PARTITION BY market_id ORDER BY taken_at ASC) AS rn_asc
      FROM price_snapshots
      WHERE taken_at >= now() - make_interval(hours => ${hours})
    ),
    now_then AS (
      SELECT n.market_id, n.yes AS yes_now, n.volume, t.yes AS yes_then
      FROM windowed n
      JOIN windowed t ON t.market_id = n.market_id AND t.rn_asc = 1
      WHERE n.rn_desc = 1 AND n.yes IS NOT NULL AND t.yes IS NOT NULL
    )
    SELECT m.id, m.venue_slug AS venue, v.name AS venue_name, m.question,
           m.category, m.source_url, nt.yes_now, nt.yes_then, nt.volume
    FROM now_then nt
    JOIN markets m ON m.id = nt.market_id AND m.closed = 0
    JOIN venues v ON v.slug = m.venue_slug
    WHERE abs(nt.yes_now - nt.yes_then) > 0.005
    ORDER BY abs(nt.yes_now - nt.yes_then) DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    venue: r.venue,
    venueName: r.venue_name,
    question: r.question,
    category: r.category,
    sourceUrl: r.source_url,
    yesNow: r.yes_now,
    yesThen: r.yes_then,
    delta: r.yes_now - r.yes_then,
    volume: r.volume,
  }));
}

/** Markets resolving soonest (open, future end date), with latest price. */
export async function listResolvingSoon(limit = 60): Promise<MarketRow[]> {
  return marketRowsWith(
    and(eq(markets.closed, 0), isNotNull(markets.endsAt), gt(markets.endsAt, new Date())),
    [asc(markets.endsAt)],
    limit,
  );
}

/** Most recently first-listed markets (early positioning). */
export async function listNewMarkets(limit = 60): Promise<MarketRow[]> {
  return marketRowsWith(eq(markets.closed, 0), [desc(markets.createdAt)], limit);
}

/** Shared builder: markets + latest snapshot, custom where/order. */
async function marketRowsWith(
  where: ReturnType<typeof and> | ReturnType<typeof eq>,
  orderBy: Array<ReturnType<typeof asc>>,
  limit: number,
): Promise<MarketRow[]> {
  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("max_taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  return db
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
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);
}

export interface ActivityRow {
  id: string;
  venue: string;
  venueName: string;
  question: string;
  category: string | null;
  sourceUrl: string;
  volumeThen: number;
  volumeNow: number;
  delta: number;
  ratio: number; // now / then
}

/**
 * Unusual activity: markets whose volume jumped most over the window
 * (latest snapshot volume vs the earliest within the window). A surge in
 * volume is the earliest tell that news is moving a market.
 */
export async function listUnusualActivity(hours = 24, limit = 40): Promise<ActivityRow[]> {
  const rows = await db.execute<{
    id: string;
    venue: string;
    venue_name: string;
    question: string;
    category: string | null;
    source_url: string;
    vol_now: number;
    vol_then: number;
  }>(sql`
    WITH windowed AS (
      SELECT market_id, volume,
             row_number() OVER (PARTITION BY market_id ORDER BY taken_at DESC) AS rn_desc,
             row_number() OVER (PARTITION BY market_id ORDER BY taken_at ASC) AS rn_asc
      FROM price_snapshots
      WHERE taken_at >= now() - make_interval(hours => ${hours}) AND volume IS NOT NULL
    ),
    nt AS (
      SELECT n.market_id, n.volume AS vol_now, t.volume AS vol_then
      FROM windowed n
      JOIN windowed t ON t.market_id = n.market_id AND t.rn_asc = 1
      WHERE n.rn_desc = 1
    )
    SELECT m.id, m.venue_slug AS venue, v.name AS venue_name, m.question,
           m.category, m.source_url, nt.vol_now, nt.vol_then
    FROM nt
    JOIN markets m ON m.id = nt.market_id AND m.closed = 0
    JOIN venues v ON v.slug = m.venue_slug
    WHERE nt.vol_now > nt.vol_then AND nt.vol_then >= 0
    ORDER BY (nt.vol_now - nt.vol_then) DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => {
    const volumeNow = Number(r.vol_now) || 0;
    const volumeThen = Number(r.vol_then) || 0;
    return {
      id: r.id,
      venue: r.venue,
      venueName: r.venue_name,
      question: r.question,
      category: r.category,
      sourceUrl: r.source_url,
      volumeThen,
      volumeNow,
      delta: volumeNow - volumeThen,
      ratio: volumeThen > 0 ? volumeNow / volumeThen : Infinity,
    };
  });
}

export async function getDataAge(): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<Date>`max(${markets.lastSeenAt})` })
    .from(markets);
  return row?.latest ?? null;
}
