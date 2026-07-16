import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots, snapshotRuns } from "@/lib/db/schema";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-curl deploy verification: env presence, DB connectivity, data
 * freshness per venue, and last snapshot run. Public and unauthenticated
 * on purpose — it exposes operational metadata only, no secrets.
 */
export async function GET() {
  const envCheck = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
  };

  if (!envCheck.DATABASE_URL || !envCheck.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, reason: "missing env vars", env: envCheck },
      { status: 503 },
    );
  }

  try {
    const [venueFreshness, lastRun] = await Promise.all([
      db
        .select({
          venue: markets.venueSlug,
          markets: sql<number>`count(distinct ${markets.id})::int`,
          latestSnapshot: sql<string | null>`max(${priceSnapshots.takenAt})::text`,
        })
        .from(markets)
        .leftJoin(priceSnapshots, sql`${priceSnapshots.marketId} = ${markets.id}`)
        .groupBy(markets.venueSlug),
      db
        .select()
        .from(snapshotRuns)
        .orderBy(sql`${snapshotRuns.startedAt} DESC`)
        .limit(1),
    ]);

    const now = Date.now();
    const venues = venueFreshness.map((v) => {
      const ageMin = v.latestSnapshot
        ? Math.round((now - new Date(v.latestSnapshot).getTime()) / 60_000)
        : null;
      return { ...v, snapshotAgeMinutes: ageMin, stale: ageMin === null || ageMin > 30 };
    });

    const anyData = venues.some((v) => v.markets > 0);
    const allFresh = venues.length > 0 && venues.every((v) => !v.stale);

    return NextResponse.json({
      ok: true,
      db: "connected",
      env: envCheck,
      dataIngested: anyData,
      allVenuesFresh: allFresh,
      venues,
      lastRun: lastRun[0]
        ? {
            id: lastRun[0].id,
            status: lastRun[0].status,
            startedAt: lastRun[0].startedAt,
            stats: lastRun[0].stats,
          }
        : null,
      hint: !anyData
        ? "No data yet. Trigger /api/cron/snapshot with the CRON_SECRET bearer token or wait for the next cron tick."
        : undefined,
    });
  } catch (err) {
    // Log the detail server-side; never echo raw DB errors to the public
    // health endpoint (Postgres errors can carry host/user/query text).
    log.error("health check db error", { error: String(err) });
    return NextResponse.json({ ok: false, db: "error", env: envCheck }, { status: 503 });
  }
}
