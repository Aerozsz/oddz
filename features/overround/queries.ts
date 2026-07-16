import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots, venues } from "@/lib/db/schema";

export interface OverroundRow {
  id: string;
  venue: string;
  venueName: string;
  question: string;
  category: string | null;
  sourceUrl: string;
  outcomes: string[];
  prices: number[];
  /** Sum of outcome prices. 1 = fair; >1 = house vig; <1 = buy-all arb. */
  sum: number;
  /** Signed deviation from 1 (sum - 1). */
  overround: number;
}

/**
 * Multi-outcome markets whose outcome prices don't sum to $1.
 *   sum > 1  → built-in house edge (the vig) — expensive to bet any side.
 *   sum < 1  → buy EVERY outcome for < $1 and one must pay $1: risk-free arb.
 * Binary markets are excluded (their two prices are constructed to sum to 1).
 */
export async function listOverround(minDev = 0.01, limit = 60): Promise<OverroundRow[]> {
  const latest = db
    .select({
      marketId: priceSnapshots.marketId,
      takenAt: sql<Date>`max(${priceSnapshots.takenAt})`.as("max_taken_at"),
    })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.marketId)
    .as("latest");

  const rows = await db
    .select({
      id: markets.id,
      venue: markets.venueSlug,
      venueName: venues.name,
      question: markets.question,
      category: markets.category,
      sourceUrl: markets.sourceUrl,
      outcomes: markets.outcomes,
      prices: priceSnapshots.prices,
    })
    .from(markets)
    .innerJoin(venues, eq(venues.slug, markets.venueSlug))
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(and(eq(markets.closed, 0), sql`jsonb_array_length(${markets.outcomes}) > 2`));

  const out: OverroundRow[] = [];
  for (const r of rows) {
    const prices = r.prices.filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length < 2) continue;
    const sum = prices.reduce((a, p) => a + p, 0);
    const overround = sum - 1;
    if (Math.abs(overround) < minDev) continue;
    out.push({
      id: r.id,
      venue: r.venue,
      venueName: r.venueName,
      question: r.question,
      category: r.category,
      sourceUrl: r.sourceUrl,
      outcomes: r.outcomes,
      prices: r.prices,
      sum,
      overround,
    });
  }

  // Most extreme first (biggest arb or biggest vig).
  out.sort((a, b) => Math.abs(b.overround) - Math.abs(a.overround));
  return out.slice(0, limit);
}
