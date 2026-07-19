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
 * Polymarket lists multi-candidate events as SIBLING binary markets (one
 * "Yes/No" market per candidate) sharing one event page (source_url).
 * Summing the latest YES across siblings reconstructs the real book:
 * that sum minus 1 is the event's true overround. This is where most of
 * the vig signal actually lives — the jsonb multi-outcome path below only
 * catches venues that encode outcomes in one market row.
 */
interface SiblingBook {
  ids: string[];
  questions: string[];
  yes: number[];
  category: string | null;
  sourceUrl: string;
  sum: number;
}

async function polymarketSiblingBooks(): Promise<SiblingBook[]> {
  const rows = await db.execute<{
    source_url: string;
    category: string | null;
    ids: string[];
    qs: string[];
    ys: number[];
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, (prices->>0)::float AS yes
      FROM price_snapshots
      ORDER BY market_id, taken_at DESC
    )
    SELECT m.source_url, min(m.category) AS category,
           array_agg(m.id) AS ids, array_agg(m.question) AS qs, array_agg(l.yes) AS ys
    FROM markets m
    JOIN latest l ON l.market_id = m.id
    WHERE m.venue_slug = 'polymarket' AND m.closed = 0
      AND l.yes IS NOT NULL AND l.yes > 0 AND l.yes < 1
      AND jsonb_array_length(m.outcomes) = 2
    GROUP BY m.source_url
    HAVING count(*) >= 3
  `);

  const out: SiblingBook[] = [];
  for (const r of rows.rows) {
    const ys = r.ys.map(Number).filter((y) => Number.isFinite(y));
    if (ys.length < 3) continue;
    const sum = ys.reduce((a, b) => a + b, 0);
    // Sane-book guard: mutually-exclusive candidate sets sum near 1. Far
    // outside that, the group is probably NOT one exclusive event (e.g. a
    // page of independent props) — skip rather than report fake vig.
    if (sum < 0.6 || sum > 1.6) continue;
    out.push({
      ids: r.ids,
      questions: r.qs,
      yes: ys,
      category: r.category,
      sourceUrl: r.source_url,
      sum,
    });
  }
  return out;
}

/** "will-x-win-the-2028-election" → "Will x win the 2028 election". */
function titleFromEventUrl(url: string): string {
  const slug = url.split("/").filter(Boolean).pop() ?? url;
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  // Polymarket sibling-market books (the bulk of real multi-outcome data).
  for (const b of await polymarketSiblingBooks()) {
    values.push({ category: b.category, overround: b.sum - 1 });
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

  for (const b of await polymarketSiblingBooks()) {
    const overround = b.sum - 1;
    if (Math.abs(overround) < minDev) continue;
    out.push({
      id: b.ids[0],
      venue: "polymarket",
      venueName: "Polymarket",
      question: titleFromEventUrl(b.sourceUrl),
      category: b.category,
      sourceUrl: b.sourceUrl,
      outcomes: b.questions,
      prices: b.yes,
      sum: b.sum,
      overround,
    });
  }

  // Most extreme first (biggest arb or biggest vig).
  out.sort((a, b) => Math.abs(b.overround) - Math.abs(a.overround));
  return out.slice(0, limit);
}
