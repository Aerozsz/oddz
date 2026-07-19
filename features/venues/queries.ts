import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export interface VenueStats {
  venue: string;
  name: string;
  markets: number;
  open: number;
  /** Sums over each open market's LATEST snapshot. */
  volume: number;
  liquidity: number;
  openInterest: number;
  /** Average vig (sum of outcome prices − 1) across open multi-outcome books. */
  avgVig: number | null;
  latestSnapshot: Date | null;
}

/**
 * The cross-venue comparison — oddz's answer to DefiLlama's Chains table.
 * Everything is computed from each market's latest snapshot so the numbers
 * are "right now", not lifetime.
 */
export async function getVenueStats(): Promise<VenueStats[]> {
  const rows = await db.execute<{
    venue: string;
    name: string;
    markets: number;
    open: number;
    volume: number | null;
    liquidity: number | null;
    open_interest: number | null;
    avg_vig: number | null;
    latest_snapshot: Date | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, prices, volume, liquidity, open_interest, taken_at
      FROM price_snapshots
      ORDER BY market_id, taken_at DESC
    ),
    per_market AS (
      SELECT m.venue_slug,
             m.closed,
             l.volume, l.liquidity, l.open_interest, l.taken_at,
             CASE WHEN jsonb_array_length(m.outcomes) > 2 THEN
               (SELECT sum(v::float) FROM jsonb_array_elements_text(l.prices) AS v) - 1
             END AS vig
      FROM markets m
      LEFT JOIN latest l ON l.market_id = m.id
    )
    SELECT p.venue_slug AS venue, v.name,
           count(*)::int AS markets,
           sum(CASE WHEN p.closed = 0 THEN 1 ELSE 0 END)::int AS open,
           sum(p.volume) FILTER (WHERE p.closed = 0) AS volume,
           sum(p.liquidity) FILTER (WHERE p.closed = 0) AS liquidity,
           sum(p.open_interest) FILTER (WHERE p.closed = 0) AS open_interest,
           avg(p.vig) FILTER (WHERE p.closed = 0 AND p.vig IS NOT NULL AND abs(p.vig) < 0.5) AS avg_vig,
           max(p.taken_at) AS latest_snapshot
    FROM per_market p
    JOIN venues v ON v.slug = p.venue_slug
    GROUP BY p.venue_slug, v.name
    ORDER BY sum(p.volume) FILTER (WHERE p.closed = 0) DESC NULLS LAST
  `);

  return rows.rows.map((r) => ({
    venue: r.venue,
    name: r.name,
    markets: Number(r.markets) || 0,
    open: Number(r.open) || 0,
    volume: Number(r.volume) || 0,
    liquidity: Number(r.liquidity) || 0,
    openInterest: Number(r.open_interest) || 0,
    avgVig: r.avg_vig === null ? null : Number(r.avg_vig),
    latestSnapshot: r.latest_snapshot,
  }));
}
