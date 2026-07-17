import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { events, markets, priceSnapshots } from "@/lib/db/schema";

export interface LeadLagRow {
  eventId: string;
  title: string;
  category: string | null;
  leader: string; // venue slug that tends to move first
  follower: string;
  lagMinutes: number; // how far the follower trails
  correlation: number; // strength of the lead/lag relationship, 0..1
  points: number; // overlapping samples used
}

const BUCKET_MIN = 15;
const MAX_LAG_BUCKETS = 8; // ±2h at 15-min buckets
const VENUE_NAMES: Record<string, string> = {
  polymarket: "Polymarket",
  kalshi: "Kalshi",
  manifold: "Manifold",
  metaculus: "Metaculus",
};

export function venueName(slug: string): string {
  return VENUE_NAMES[slug] ?? slug;
}

/** Pearson correlation of two equal-length series. */
function corr(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/**
 * For each binary event traded on ≥2 venues, resample both YES series to a
 * 15-min grid, take price *changes*, and find the lag k that maximizes the
 * cross-correlation between one venue's changes and the other's k buckets
 * later. The venue whose moves best predict the other's future moves is the
 * leader — a front-running signal (bet the lagging venue when the leader has
 * already moved). Needs dense history, so it's sparse until prod data
 * accumulates.
 */
export async function listLeadLag(hours = 72, minCorr = 0.35, limit = 40): Promise<LeadLagRow[]> {
  const since = new Date(Date.now() - hours * 3600_000);

  const rows = await db
    .select({
      eventId: events.id,
      title: events.title,
      category: events.category,
      venue: markets.venueSlug,
      takenAt: priceSnapshots.takenAt,
      prices: priceSnapshots.prices,
    })
    .from(events)
    .innerJoin(markets, and(eq(markets.eventId, events.id), eq(markets.closed, 0)))
    .innerJoin(priceSnapshots, eq(priceSnapshots.marketId, markets.id))
    .where(and(sql`jsonb_array_length(${markets.outcomes}) = 2`, sql`${priceSnapshots.takenAt} >= ${since}`))
    .orderBy(priceSnapshots.takenAt);

  // event -> venue -> bucket -> yes
  const byEvent = new Map<
    string,
    { title: string; category: string | null; venues: Map<string, Map<number, number>> }
  >();
  for (const r of rows) {
    const yes = r.prices[0];
    if (yes === undefined || !Number.isFinite(yes)) continue;
    const bucket = Math.floor(r.takenAt.getTime() / (BUCKET_MIN * 60_000));
    const e = byEvent.get(r.eventId) ?? { title: r.title, category: r.category, venues: new Map() };
    const v = e.venues.get(r.venue) ?? new Map<number, number>();
    v.set(bucket, yes); // last write per bucket wins
    e.venues.set(r.venue, v);
    byEvent.set(r.eventId, e);
  }

  const out: LeadLagRow[] = [];
  for (const [eventId, e] of byEvent) {
    const venues = [...e.venues.keys()];
    if (venues.length < 2) continue;

    // Use the two venues with the most overlapping samples.
    let best: LeadLagRow | null = null;
    for (let i = 0; i < venues.length; i++) {
      for (let j = i + 1; j < venues.length; j++) {
        const A = e.venues.get(venues[i])!;
        const B = e.venues.get(venues[j])!;
        const buckets = [...A.keys()].filter((b) => B.has(b)).sort((x, y) => x - y);
        if (buckets.length < 6) continue;
        // Change series on the common grid.
        const dA: number[] = [];
        const dB: number[] = [];
        for (let k = 1; k < buckets.length; k++) {
          dA.push(A.get(buckets[k])! - A.get(buckets[k - 1])!);
          dB.push(B.get(buckets[k])! - B.get(buckets[k - 1])!);
        }
        // Scan lags: positive lag = i leads j.
        for (let lag = -MAX_LAG_BUCKETS; lag <= MAX_LAG_BUCKETS; lag++) {
          if (lag === 0) continue;
          const x: number[] = [];
          const y: number[] = [];
          for (let t = 0; t < dA.length; t++) {
            const tt = t + lag;
            if (tt < 0 || tt >= dB.length) continue;
            x.push(dA[t]);
            y.push(dB[tt]);
          }
          const c = corr(x, y);
          const [leader, follower] = lag > 0 ? [venues[i], venues[j]] : [venues[j], venues[i]];
          if (c >= minCorr && (!best || c > best.correlation)) {
            best = {
              eventId,
              title: e.title,
              category: e.category,
              leader,
              follower,
              lagMinutes: Math.abs(lag) * BUCKET_MIN,
              correlation: c,
              points: x.length,
            };
          }
        }
      }
    }
    if (best) out.push(best);
  }

  out.sort((a, b) => b.correlation - a.correlation);
  return out.slice(0, limit);
}
