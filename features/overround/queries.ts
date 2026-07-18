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

export interface OverroundDistribution {
  /** Every analysed multi-outcome market's signed vig (sum - 1). */
  values: { category: string | null; overround: number }[];
  count: number;
  median: number | null;
  /** Histogram bins over vig in percentage points, low → high. */
  bins: { from: number; to: number; count: number; healthy: boolean }[];
  /** Average vig per category, most expensive first. */
  byCategory: { category: string; avg: number; count: number }[];
}

// Vig at or below this (in fraction, i.e. 4pp) counts as a "healthy" book.
const HEALTHY_VIG = 0.04;

/**
 * Distribution of the vig across ALL open multi-outcome markets (no min
 * deviation filter) — powers the histogram and the by-category bars.
 */
export async function getOverroundDistribution(): Promise<OverroundDistribution> {
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
      category: markets.category,
      prices: priceSnapshots.prices,
    })
    .from(markets)
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(and(eq(markets.closed, 0), sql`jsonb_array_length(${markets.outcomes}) > 2`));

  const values: { category: string | null; overround: number }[] = [];
  for (const r of rows) {
    const prices = r.prices.filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length < 2) continue;
    const overround = prices.reduce((a, p) => a + p, 0) - 1;
    // Ignore obviously broken sums (stale/partial snapshots) beyond ±50pp.
    if (Math.abs(overround) > 0.5) continue;
    values.push({ category: r.category, overround });
  }

  const sorted = values.map((v) => v.overround).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted[Math.floor((sorted.length - 1) / 2)]
    : null;

  // Histogram: 2pp-wide bins from -6pp to +20pp, with catch-all tails.
  const edges = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.14, 0.2];
  const bins = edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    const count = sorted.filter((v) => v >= from && v < to).length;
    return { from, to, count, healthy: to <= HEALTHY_VIG + 1e-9 };
  });

  const catMap = new Map<string, { sum: number; count: number }>();
  for (const v of values) {
    const key = v.category ?? "Uncategorised";
    const c = catMap.get(key) ?? { sum: 0, count: 0 };
    c.sum += v.overround;
    c.count += 1;
    catMap.set(key, c);
  }
  const byCategory = [...catMap.entries()]
    .map(([category, c]) => ({ category, avg: c.sum / c.count, count: c.count }))
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  return { values, count: values.length, median, bins, byCategory };
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
