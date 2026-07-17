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

export interface VolumePoint {
  t: string;
  total: number;
}

export interface FeaturedMarket {
  id: string;
  question: string;
  category: string | null;
  venueName: string;
  yes: number;
  sourceUrl: string;
}

export interface Dashboard {
  overview: Overview;
  series: VolumePoint[]; // total volume per hour bucket, up to 30d
  changePct: number; // total-volume change over the last 24h
  featured: FeaturedMarket | null;
}

/** Total-volume time series (latest volume per market per hour, summed). */
async function getVolumeSeries(hours: number): Promise<VolumePoint[]> {
  const rows = await db.execute<{ t: string; total: number }>(sql`
    WITH per_market_bucket AS (
      SELECT DISTINCT ON (market_id, date_trunc('hour', taken_at))
        market_id, date_trunc('hour', taken_at) AS bucket, volume
      FROM price_snapshots
      WHERE taken_at >= now() - make_interval(hours => ${hours}) AND volume IS NOT NULL
      ORDER BY market_id, date_trunc('hour', taken_at), taken_at DESC
    )
    SELECT bucket::text AS t, sum(volume)::float AS total
    FROM per_market_bucket GROUP BY bucket ORDER BY bucket
  `);
  return rows.rows.map((r) => ({ t: r.t, total: Number(r.total) || 0 }));
}

async function getFeatured(): Promise<FeaturedMarket | null> {
  const rows = await db.execute<{
    id: string;
    question: string;
    category: string | null;
    venue_name: string;
    yes: number;
    source_url: string;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, prices, volume
      FROM price_snapshots ORDER BY market_id, taken_at DESC
    )
    SELECT m.id, m.question, m.category, v.name AS venue_name,
           (l.prices->>0)::float AS yes, m.source_url
    FROM markets m
    JOIN latest l ON l.market_id = m.id
    JOIN venues v ON v.slug = m.venue_slug
    WHERE m.closed = 0 AND jsonb_array_length(m.outcomes) = 2
      AND (l.prices->>0)::float > 0 AND (l.prices->>0)::float < 1
    ORDER BY l.volume DESC NULLS LAST
    LIMIT 1
  `);
  const r = rows.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    question: r.question,
    category: r.category,
    venueName: r.venue_name,
    yes: Number(r.yes),
    sourceUrl: r.source_url,
  };
}

/** Everything the dashboard (design section 04) needs, in one call. */
export async function getDashboard(): Promise<Dashboard> {
  const [overview, series, featured] = await Promise.all([
    getOverview(),
    getVolumeSeries(24 * 30),
    getFeatured(),
  ]);

  // 24h change from the series (first bucket in the last ~24h vs latest).
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = series.filter((p) => new Date(p.t).getTime() >= cutoff);
  const first = recent[0]?.total ?? series[0]?.total ?? 0;
  const last = series.at(-1)?.total ?? 0;
  const changePct = first > 0 ? (last - first) / first : 0;

  return { overview, series, changePct, featured };
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
