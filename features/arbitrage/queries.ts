import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { events, markets, priceSnapshots } from "@/lib/db/schema";

export interface ArbLeg {
  venue: string;
  marketId: string;
  sourceUrl: string;
  yes: number;
  /** Latest reported liquidity on this leg's book, if the venue exposes it. */
  liquidity: number | null;
}

export interface ArbOpportunity {
  eventId: string;
  title: string;
  category: string | null;
  /** Buy YES here (cheapest YES). */
  buyYes: ArbLeg;
  /** Buy NO here (cheapest NO = highest YES venue). */
  buyNo: ArbLeg;
  yesCost: number;
  noCost: number;
  totalCost: number;
  /** Gross locked edge for a $1 payout, before fees. = 1 - totalCost. */
  edge: number;
}

/**
 * Cross-venue lock-in arbitrage for binary events listed on ≥2 venues.
 *
 * For a binary event, buying YES on the venue with the lowest YES price
 * and NO on the venue with the highest YES price (cheapest NO) locks a
 * guaranteed $1 payout for `yesCost + noCost`. When that total is < $1,
 * the difference is risk-free edge (before venue fees + slippage).
 *
 * This is the single most actionable signal for a prediction-market
 * trader: genuine, executable free money across venues.
 */
export async function listArbitrage(minEdge = 0.005, limit = 50): Promise<ArbOpportunity[]> {
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
      liquidity: priceSnapshots.liquidity,
    })
    .from(events)
    .innerJoin(markets, and(eq(markets.eventId, events.id), eq(markets.closed, 0)))
    .innerJoin(latest, eq(latest.marketId, markets.id))
    .innerJoin(
      priceSnapshots,
      and(eq(priceSnapshots.marketId, latest.marketId), eq(priceSnapshots.takenAt, latest.takenAt)),
    )
    .where(sql`jsonb_array_length(${markets.outcomes}) = 2`);

  const byEvent = new Map<string, { title: string; category: string | null; legs: ArbLeg[] }>();
  for (const r of rows) {
    const yes = r.prices[0];
    if (yes === undefined || !Number.isFinite(yes) || yes <= 0 || yes >= 1) continue;
    const g = byEvent.get(r.eventId) ?? { title: r.title, category: r.category, legs: [] };
    g.legs.push({
      venue: r.venue,
      marketId: r.marketId,
      sourceUrl: r.sourceUrl,
      yes,
      liquidity: r.liquidity === null ? null : Number(r.liquidity),
    });
    byEvent.set(r.eventId, g);
  }

  const out: ArbOpportunity[] = [];
  for (const [eventId, g] of byEvent) {
    if (g.legs.length < 2) continue;
    // Cheapest YES and cheapest NO (= highest YES) may be the same leg only
    // if all legs equal; require distinct venues for a real cross-venue arb.
    const cheapestYes = g.legs.reduce((a, b) => (b.yes < a.yes ? b : a));
    const highestYes = g.legs.reduce((a, b) => (b.yes > a.yes ? b : a));
    if (cheapestYes.venue === highestYes.venue) continue;

    const yesCost = cheapestYes.yes;
    const noCost = 1 - highestYes.yes;
    const totalCost = yesCost + noCost;
    const edge = 1 - totalCost;
    if (edge < minEdge) continue;

    out.push({
      eventId,
      title: g.title,
      category: g.category,
      buyYes: cheapestYes,
      buyNo: highestYes,
      yesCost,
      noCost,
      totalCost,
      edge,
    });
  }

  out.sort((a, b) => b.edge - a.edge);
  return out.slice(0, limit);
}
