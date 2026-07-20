import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { safeEqual } from "@/lib/api-auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, `Bearer ${secret}`)) return true;
  const key = new URL(req.url).searchParams.get("key");
  return key !== null && safeEqual(key, secret);
}

/**
 * Data-health diagnostics, CRON_SECRET-gated. Answers "why is page X
 * empty?" with numbers instead of guesses:
 *   matcher   — how many events actually link ≥2 venues (feeds arbitrage,
 *               consensus, divergence, lead/lag)
 *   books     — Polymarket sibling books found (feeds overround)
 *   history   — snapshot depth per venue (feeds lead/lag, charts)
 * GET /api/admin/stats?key=<CRON_SECRET>
 */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [matcher, books, history, unlinked] = await Promise.all([
    db.execute<{ venues: number; events: number }>(sql`
      SELECT venue_count AS venues, count(*)::int AS events
      FROM (
        SELECT e.id, count(DISTINCT m.venue_slug)::int AS venue_count
        FROM events e JOIN markets m ON m.event_id = e.id AND m.closed = 0
        GROUP BY e.id
      ) t
      GROUP BY venue_count ORDER BY venue_count
    `),
    db.execute<{ books: number }>(sql`
      SELECT count(*)::int AS books FROM (
        SELECT m.source_url
        FROM markets m
        WHERE m.venue_slug = 'polymarket' AND m.closed = 0
        GROUP BY m.source_url HAVING count(*) >= 3
      ) b
    `),
    db.execute<{ venue: string; snapshots: number; days: number }>(sql`
      SELECT m.venue_slug AS venue, count(*)::int AS snapshots,
             (EXTRACT(EPOCH FROM (max(ps.taken_at) - min(ps.taken_at))) / 86400)::int AS days
      FROM price_snapshots ps JOIN markets m ON m.id = ps.market_id
      GROUP BY m.venue_slug
    `),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM markets WHERE event_id IS NULL
    `),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    matcher: {
      eventsByVenueCount: matcher.rows,
      crossVenueEvents: matcher.rows
        .filter((r) => Number(r.venues) >= 2)
        .reduce((a, r) => a + Number(r.events), 0),
      unlinkedMarkets: Number(unlinked.rows[0]?.n ?? 0),
    },
    overround: { polymarketSiblingBooks: Number(books.rows[0]?.books ?? 0) },
    history: history.rows,
  });
}
