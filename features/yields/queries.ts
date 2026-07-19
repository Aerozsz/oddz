import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export interface YieldRow {
  id: string;
  venue: string;
  venueName: string;
  question: string;
  category: string | null;
  sourceUrl: string;
  /** Side you'd buy (the favorite) and its price. */
  side: "YES" | "NO";
  price: number;
  /** Gross return if the favorite resolves true: (1 - price) / price. */
  ret: number;
  /** Annualized (simple) using days to resolution. */
  apr: number;
  daysLeft: number;
  liquidity: number | null;
  volume: number | null;
}

/**
 * The "bond desk" of prediction markets: near-certain favorites resolving
 * soon. Buying the favorite at 95% that settles in 10 days returns 5.3%
 * gross — ~192% annualized IF it resolves as priced. The screener surfaces
 * the rate; the risk column (price, time, liquidity) is the buyer's job.
 */
export async function listYields(opts?: {
  minPrice?: number;
  maxDays?: number;
  limit?: number;
}): Promise<YieldRow[]> {
  const minPrice = opts?.minPrice ?? 0.85;
  const maxDays = opts?.maxDays ?? 60;
  const limit = opts?.limit ?? 60;

  const rows = await db.execute<{
    id: string;
    venue: string;
    venue_name: string;
    question: string;
    category: string | null;
    source_url: string;
    yes: number;
    liquidity: number | null;
    volume: number | null;
    days_left: number;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, (prices->>0)::float AS yes, liquidity, volume
      FROM price_snapshots
      ORDER BY market_id, taken_at DESC
    )
    SELECT m.id, m.venue_slug AS venue, v.name AS venue_name, m.question, m.category,
           m.source_url, l.yes, l.liquidity, l.volume,
           EXTRACT(EPOCH FROM (m.ends_at - now())) / 86400.0 AS days_left
    FROM markets m
    JOIN venues v ON v.slug = m.venue_slug
    JOIN latest l ON l.market_id = m.id
    WHERE m.closed = 0
      AND m.ends_at IS NOT NULL
      AND m.ends_at > now()
      AND m.ends_at <= now() + make_interval(days => ${maxDays})
      AND jsonb_array_length(m.outcomes) = 2
      AND l.yes IS NOT NULL AND l.yes > 0 AND l.yes < 1
      AND greatest(l.yes, 1 - l.yes) >= ${minPrice}
  `);

  const out: YieldRow[] = rows.rows.map((r) => {
    const yes = Number(r.yes);
    const side: "YES" | "NO" = yes >= 0.5 ? "YES" : "NO";
    const price = side === "YES" ? yes : 1 - yes;
    const ret = (1 - price) / price;
    const daysLeft = Math.max(Number(r.days_left), 0.25); // floor to 6h to avoid silly APRs
    const apr = ret * (365 / daysLeft);
    return {
      id: r.id,
      venue: r.venue,
      venueName: r.venue_name,
      question: r.question,
      category: r.category,
      sourceUrl: r.source_url,
      side,
      price,
      ret,
      apr,
      daysLeft: Number(r.days_left),
      liquidity: r.liquidity === null ? null : Number(r.liquidity),
      volume: r.volume === null ? null : Number(r.volume),
    };
  });

  out.sort((a, b) => b.apr - a.apr);
  return out.slice(0, limit);
}
