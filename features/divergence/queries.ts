import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { events, markets, priceSnapshots } from "@/lib/db/schema";

export interface DivergenceRow {
  eventId: string;
  title: string;
  category: string | null;
  legs: {
    venue: string;
    marketId: string;
    slug: string;
    yes: number;
    sourceUrl: string;
  }[];
  spread: number;
}

/**
 * For each event linked to ≥2 venues, return the latest YES price from each
 * venue and the spread between max and min. Only binary markets contribute
 * (we look at outcomes[0] which is normalized to YES on every venue except
 * Polymarket multi-outcomes, which we filter out by requiring outcomes=2).
 */
export async function listDivergences(limit = 50): Promise<DivergenceRow[]> {
  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  const rows = await db
    .select({
      eventId: events.id,
      title: events.title,
      category: events.category,
      venue: markets.venueSlug,
      marketId: markets.id,
      slug: markets.slug,
      sourceUrl: markets.sourceUrl,
      outcomes: markets.outcomes,
      prices: priceSnapshots.prices,
    })
    .from(events)
    .innerJoin(markets, and(eq(markets.eventId, events.id), eq(markets.closed, 0)))
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(sql`jsonb_array_length(${markets.outcomes}) = 2`);

  // Group in JS — number of events with ≥2 venues is small (it's the whole point).
  const grouped = new Map<string, DivergenceRow>();
  for (const r of rows) {
    const yes = r.prices[0];
    if (yes === undefined || !Number.isFinite(yes)) continue;
    const existing = grouped.get(r.eventId);
    const leg = {
      venue: r.venue,
      marketId: r.marketId,
      slug: r.slug,
      yes,
      sourceUrl: r.sourceUrl,
    };
    if (existing) {
      existing.legs.push(leg);
    } else {
      grouped.set(r.eventId, {
        eventId: r.eventId,
        title: r.title,
        category: r.category,
        legs: [leg],
        spread: 0,
      });
    }
  }

  const result: DivergenceRow[] = [];
  for (const row of grouped.values()) {
    if (row.legs.length < 2) continue;
    const ys = row.legs.map((l) => l.yes);
    row.spread = Math.max(...ys) - Math.min(...ys);
    result.push(row);
  }

  result.sort((a, b) => b.spread - a.spread);
  return result.slice(0, limit);
}
