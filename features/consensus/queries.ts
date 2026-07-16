import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { events, markets, priceSnapshots } from "@/lib/db/schema";

export interface ConsensusLeg {
  venue: string;
  venueName: string;
  marketId: string;
  sourceUrl: string;
  yes: number;
  volume: number;
  /** Signed gap vs consensus, in percentage points (yes - consensus). */
  edge: number;
}

export interface ConsensusRow {
  eventId: string;
  title: string;
  category: string | null;
  /** Volume-weighted YES across venues — the crowd's fair value. */
  consensus: number;
  totalVolume: number;
  legs: ConsensusLeg[];
  /** Largest absolute leg gap vs consensus (the mispricing to trade). */
  maxEdge: number;
}

const VENUE_NAMES: Record<string, string> = {
  polymarket: "Polymarket",
  kalshi: "Kalshi",
  manifold: "Manifold",
  metaculus: "Metaculus",
};

/**
 * Volume-weighted consensus probability for binary events on ≥2 venues.
 * The consensus is the crowd's fair value; a venue trading far from it is
 * a mispricing — buy the venue below consensus, fade the one above. More
 * robust than raw divergence because it weights by where the money is.
 */
export async function listConsensus(minEdge = 0.02, limit = 50): Promise<ConsensusRow[]> {
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
      eventId: events.id,
      title: events.title,
      category: events.category,
      venue: markets.venueSlug,
      marketId: markets.id,
      sourceUrl: markets.sourceUrl,
      prices: priceSnapshots.prices,
      volume: priceSnapshots.volume,
    })
    .from(events)
    .innerJoin(markets, and(eq(markets.eventId, events.id), eq(markets.closed, 0)))
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(sql`jsonb_array_length(${markets.outcomes}) = 2`);

  const grouped = new Map<
    string,
    { title: string; category: string | null; legs: Omit<ConsensusLeg, "edge">[] }
  >();
  for (const r of rows) {
    const yes = r.prices[0];
    if (yes === undefined || !Number.isFinite(yes) || yes <= 0 || yes >= 1) continue;
    const g = grouped.get(r.eventId) ?? { title: r.title, category: r.category, legs: [] };
    g.legs.push({
      venue: r.venue,
      venueName: VENUE_NAMES[r.venue] ?? r.venue,
      marketId: r.marketId,
      sourceUrl: r.sourceUrl,
      yes,
      volume: Number(r.volume) || 0,
    });
    grouped.set(r.eventId, g);
  }

  const out: ConsensusRow[] = [];
  for (const [eventId, g] of grouped) {
    if (g.legs.length < 2) continue;
    const totalVolume = g.legs.reduce((a, l) => a + l.volume, 0);
    // Volume-weighted; fall back to simple mean if no volume anywhere.
    const consensus =
      totalVolume > 0
        ? g.legs.reduce((a, l) => a + l.yes * l.volume, 0) / totalVolume
        : g.legs.reduce((a, l) => a + l.yes, 0) / g.legs.length;

    const legs: ConsensusLeg[] = g.legs.map((l) => ({ ...l, edge: l.yes - consensus }));
    const maxEdge = Math.max(...legs.map((l) => Math.abs(l.edge)));
    if (maxEdge < minEdge) continue;

    out.push({ eventId, title: g.title, category: g.category, consensus, totalVolume, legs, maxEdge });
  }

  out.sort((a, b) => b.maxEdge - a.maxEdge);
  return out.slice(0, limit);
}
