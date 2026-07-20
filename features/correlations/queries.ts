import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export interface CorrMarket {
  id: string;
  question: string;
  venue: string;
  volume: number;
}

export interface CorrCell {
  a: string; // market id
  b: string;
  rho: number;
  points: number;
}

export interface CorrelationMatrix {
  markets: CorrMarket[];
  cells: CorrCell[]; // upper triangle only
  hours: number;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Pairwise correlation of hourly YES-price CHANGES across the biggest open
 * books. Changes, not levels — two markets drifting the same direction all
 * week correlate on levels trivially; co-moving hour to hour is the signal
 * a hedger cares about.
 */
export async function getCorrelationMatrix(
  hours = 72,
  topN = 16,
): Promise<CorrelationMatrix> {
  // Top open markets by latest volume that have history in the window.
  const top = await db.execute<{
    id: string;
    question: string;
    venue: string;
    volume: number | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, volume
      FROM price_snapshots
      ORDER BY market_id, taken_at DESC
    )
    SELECT m.id, m.question, m.venue_slug AS venue, l.volume
    FROM markets m
    JOIN latest l ON l.market_id = m.id
    WHERE m.closed = 0 AND jsonb_array_length(m.outcomes) = 2
    ORDER BY l.volume DESC NULLS LAST
    LIMIT ${topN}
  `);
  const markets: CorrMarket[] = top.rows.map((r) => ({
    id: r.id,
    question: r.question,
    venue: r.venue,
    volume: Number(r.volume) || 0,
  }));
  if (markets.length < 2) return { markets, cells: [], hours };

  // Hourly last YES per market over the window.
  const hist = await db.execute<{ market_id: string; hour: string; yes: number }>(sql`
    SELECT DISTINCT ON (market_id, date_trunc('hour', taken_at))
           market_id,
           to_char(date_trunc('hour', taken_at), 'YYYY-MM-DD-HH24') AS hour,
           (prices->>0)::float AS yes
    FROM price_snapshots
    WHERE taken_at >= now() - make_interval(hours => ${hours})
      AND market_id IN (${sql.join(markets.map((m) => sql`${m.id}`), sql`, `)})
    ORDER BY market_id, date_trunc('hour', taken_at), taken_at DESC
  `);

  // hour -> yes per market, then per-market hourly diffs keyed by hour.
  const series = new Map<string, Map<string, number>>();
  for (const r of hist.rows) {
    const m = series.get(r.market_id) ?? new Map<string, number>();
    m.set(r.hour, Number(r.yes));
    series.set(r.market_id, m);
  }
  const diffs = new Map<string, Map<string, number>>();
  for (const [id, m] of series) {
    const hoursSorted = [...m.keys()].sort();
    const d = new Map<string, number>();
    for (let i = 1; i < hoursSorted.length; i++) {
      d.set(hoursSorted[i], m.get(hoursSorted[i])! - m.get(hoursSorted[i - 1])!);
    }
    diffs.set(id, d);
  }

  const cells: CorrCell[] = [];
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const da = diffs.get(markets[i].id);
      const dbb = diffs.get(markets[j].id);
      if (!da || !dbb) continue;
      const shared = [...da.keys()].filter((h) => dbb.has(h));
      if (shared.length < 8) continue; // too little overlap to claim anything
      const rho = pearson(
        shared.map((h) => da.get(h)!),
        shared.map((h) => dbb.get(h)!),
      );
      if (rho === null) continue;
      cells.push({ a: markets[i].id, b: markets[j].id, rho, points: shared.length });
    }
  }

  return { markets, cells, hours };
}
