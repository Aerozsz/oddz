import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots } from "@/lib/db/schema";

export interface VenueStat {
  venue: string;
  markets: number;
  volume: number;
  share: number; // 0..1 of total volume (venue dominance)
}

export interface CategoryStat {
  category: string;
  markets: number;
  volume: number;
}

export interface Overview {
  totalVolume: number;
  totalMarkets: number;
  venues: VenueStat[];
  categories: CategoryStat[];
}

/**
 * DefiLlama-style aggregate layer: total volume + market count, venue
 * dominance (volume share), and category rollups — all derived from the
 * latest snapshot per open market. One round-trip via a shared CTE.
 */
export async function getOverview(): Promise<Overview> {
  // latest snapshot volume per open market, joined to its venue+category
  const rows = await db.execute<{
    venue: string;
    category: string | null;
    volume: number | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, volume
      FROM price_snapshots
      ORDER BY market_id, taken_at DESC
    )
    SELECT m.venue_slug AS venue, m.category, l.volume
    FROM markets m
    JOIN latest l ON l.market_id = m.id
    WHERE m.closed = 0
  `);

  let totalVolume = 0;
  let totalMarkets = 0;
  const venueMap = new Map<string, { markets: number; volume: number }>();
  const catMap = new Map<string, { markets: number; volume: number }>();

  for (const r of rows.rows) {
    const vol = Number(r.volume) || 0;
    totalVolume += vol;
    totalMarkets += 1;

    const v = venueMap.get(r.venue) ?? { markets: 0, volume: 0 };
    v.markets += 1;
    v.volume += vol;
    venueMap.set(r.venue, v);

    if (r.category) {
      const key = r.category.toLowerCase();
      const c = catMap.get(key) ?? { markets: 0, volume: 0 };
      c.markets += 1;
      c.volume += vol;
      catMap.set(key, c);
    }
  }

  const venues: VenueStat[] = Array.from(venueMap, ([venue, s]) => ({
    venue,
    markets: s.markets,
    volume: s.volume,
    share: totalVolume > 0 ? s.volume / totalVolume : 0,
  })).sort((a, b) => b.volume - a.volume);

  const categories: CategoryStat[] = Array.from(catMap, ([category, s]) => ({
    category,
    markets: s.markets,
    volume: s.volume,
  }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);

  return { totalVolume, totalMarkets, venues, categories };
}
