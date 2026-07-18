import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots, snapshotRuns } from "@/lib/db/schema";

export async function recentRuns(limit = 20) {
  return db
    .select()
    .from(snapshotRuns)
    .orderBy(desc(snapshotRuns.startedAt))
    .limit(limit);
}

export async function venueCounts() {
  return db
    .select({
      venue: markets.venueSlug,
      total: sql<number>`count(*)::int`,
      open: sql<number>`sum(case when ${markets.closed} = 0 then 1 else 0 end)::int`,
      latestSeen: sql<Date>`max(${markets.lastSeenAt})`,
    })
    .from(markets)
    .groupBy(markets.venueSlug);
}

export async function snapshotCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(priceSnapshots);
  return row?.n ?? 0;
}

export interface VenueUptime {
  venue: string;
  /** One entry per day, oldest first. state: ok = ran clean, down = had an error, none = no run. */
  cells: { day: string; state: "ok" | "down" | "none" }[];
  uptimePct: number | null;
}

/**
 * Per-venue daily ingestion health for the last `days` days, unpacking the
 * per-venue stats JSON. A day is "down" if any run that day recorded an error
 * for that venue, "ok" if it ran clean, "none" if the venue didn't run.
 */
export async function venueUptime(days = 30): Promise<VenueUptime[]> {
  const rows = await db.execute<{ venue: string; day: string; had_error: boolean; runs: number }>(sql`
    SELECT kv.key AS venue,
           to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
           bool_or((kv.value->>'error') IS NOT NULL) AS had_error,
           count(*)::int AS runs
    FROM snapshot_runs, jsonb_each(stats) AS kv
    WHERE started_at >= now() - make_interval(days => ${days})
    GROUP BY 1, 2
  `);

  // Build the day axis (oldest → newest) once.
  const axis: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().slice(0, 10));
  }

  const byVenue = new Map<string, Map<string, boolean>>(); // venue -> day -> hadError
  for (const r of rows.rows) {
    if (!byVenue.has(r.venue)) byVenue.set(r.venue, new Map());
    byVenue.get(r.venue)!.set(r.day, Boolean(r.had_error));
  }

  return [...byVenue.entries()]
    .map(([venue, dayMap]) => {
      const cells = axis.map((day) => {
        if (!dayMap.has(day)) return { day, state: "none" as const };
        return { day, state: dayMap.get(day) ? ("down" as const) : ("ok" as const) };
      });
      const ran = cells.filter((c) => c.state !== "none");
      const uptimePct = ran.length
        ? (ran.filter((c) => c.state === "ok").length / ran.length) * 100
        : null;
      return { venue, cells, uptimePct };
    })
    .sort((a, b) => a.venue.localeCompare(b.venue));
}

export async function freshnessByVenue() {
  return db
    .select({
      venue: markets.venueSlug,
      latestSnapshot: sql<Date>`max(${priceSnapshots.takenAt})`,
    })
    .from(priceSnapshots)
    .innerJoin(markets, eq(markets.id, priceSnapshots.marketId))
    .groupBy(markets.venueSlug);
}
