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

export interface ListMarketsParams {
  q?: string;
  venue?: VenueSlug;
  limit?: number;
  offset?: number;
}

export async function listMarkets(params: ListMarketsParams = {}): Promise<MarketRow[]> {
  const { q, venue, limit = 50, offset = 0 } = params;

  // Subquery: most recent snapshot per market.
  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  const filters = [eq(markets.closed, 0)];
  if (venue) filters.push(eq(markets.venueSlug, venue));
  if (q && q.trim()) {
    const needle = `%${q.trim()}%`;
    const f = or(ilike(markets.question, needle), ilike(markets.category, needle));
    if (f) filters.push(f);
  }

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
    .orderBy(desc(priceSnapshots.volume), desc(markets.lastSeenAt))
    .limit(limit)
    .offset(offset);

  return rows;
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

export async function getDataAge(): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<Date>`max(${markets.lastSeenAt})` })
    .from(markets);
  return row?.latest ?? null;
}
