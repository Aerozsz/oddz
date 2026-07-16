import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { events, markets, priceSnapshots, venues } from "@/lib/db/schema";

export interface EventLeg {
  marketId: string;
  venue: string;
  venueName: string;
  slug: string;
  question: string;
  sourceUrl: string;
  yes: number | null;
  volume: number | null;
  liquidity: number | null;
}

export interface EventDetail {
  id: string;
  title: string;
  category: string | null;
  endsAt: Date | null;
  legs: EventLeg[];
}

export async function getEvent(id: string): Promise<EventDetail | null> {
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  if (!event) return null;

  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("max_taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  const legs = await db
    .select({
      marketId: markets.id,
      venue: markets.venueSlug,
      venueName: venues.name,
      slug: markets.slug,
      question: markets.question,
      sourceUrl: markets.sourceUrl,
      prices: priceSnapshots.prices,
      volume: priceSnapshots.volume,
      liquidity: priceSnapshots.liquidity,
    })
    .from(markets)
    .innerJoin(venues, eq(venues.slug, markets.venueSlug))
    .leftJoin(latest, eq(latest.marketId, markets.id))
    .leftJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(eq(markets.eventId, id));

  return {
    id: event.id,
    title: event.title,
    category: event.category,
    endsAt: event.endsAt,
    legs: legs.map((l) => ({
      marketId: l.marketId,
      venue: l.venue,
      venueName: l.venueName,
      slug: l.slug,
      question: l.question,
      sourceUrl: l.sourceUrl,
      yes: l.prices?.[0] ?? null,
      volume: l.volume,
      liquidity: l.liquidity,
    })),
  };
}

export interface OverlayPoint {
  t: string;
  [venue: string]: string | number;
}

/**
 * Merge per-leg YES histories into one overlay series, bucketing
 * timestamps to 5-minute grid so venues snapshotted seconds apart land
 * on the same x position.
 */
export async function getEventHistory(id: string, sinceHours = 24 * 7): Promise<OverlayPoint[]> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await db
    .select({
      venue: markets.venueSlug,
      takenAt: priceSnapshots.takenAt,
      prices: priceSnapshots.prices,
    })
    .from(priceSnapshots)
    .innerJoin(markets, eq(markets.id, priceSnapshots.marketId))
    .where(and(eq(markets.eventId, id), sql`${priceSnapshots.takenAt} >= ${since}`))
    .orderBy(priceSnapshots.takenAt);

  const BUCKET_MS = 5 * 60 * 1000;
  const buckets = new Map<number, OverlayPoint>();
  for (const r of rows) {
    const yes = r.prices?.[0];
    if (yes === undefined || !Number.isFinite(yes)) continue;
    const bucket = Math.floor(r.takenAt.getTime() / BUCKET_MS) * BUCKET_MS;
    let point = buckets.get(bucket);
    if (!point) {
      point = { t: new Date(bucket).toISOString() };
      buckets.set(bucket, point);
    }
    point[r.venue] = yes;
  }
  return Array.from(buckets.values());
}
