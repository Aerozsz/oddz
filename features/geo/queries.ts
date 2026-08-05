import { desc, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { geoMonitorRuns, geoSignals } from "@/lib/db/schema";
import type { Side, Theater } from "@/lib/geo/types";

export interface GeoItem {
  id: string;
  sourceLabel: string;
  title: string;
  url: string;
  summary: string | null;
  side: Side;
  theater: Theater;
  intensity: "low" | "medium" | "high" | "critical";
  marketLean: "risk_on" | "risk_off" | "mixed";
  score: number;
  tags: string[];
  publishedAt: Date | null;
  firstSeenAt: Date;
  notifiedAt: Date | null;
  /** publishedAt ?? firstSeenAt — the timestamp the UI sorts and decays by. */
  at: Date;
}

/** All signals within the window, newest first. The page derives everything
 *  else (tilt, theater strip, the two columns) from this one set. */
export async function signalsWindow(hours = 48, limit = 200): Promise<GeoItem[]> {
  const rows = await db
    .select({
      id: geoSignals.id,
      sourceLabel: geoSignals.sourceLabel,
      title: geoSignals.title,
      url: geoSignals.url,
      summary: geoSignals.summary,
      side: geoSignals.side,
      theater: geoSignals.theater,
      intensity: geoSignals.intensity,
      marketLean: geoSignals.marketLean,
      score: geoSignals.score,
      tags: geoSignals.tags,
      publishedAt: geoSignals.publishedAt,
      firstSeenAt: geoSignals.firstSeenAt,
      notifiedAt: geoSignals.notifiedAt,
    })
    .from(geoSignals)
    .where(gte(sql`coalesce(${geoSignals.publishedAt}, ${geoSignals.firstSeenAt})`, sql`now() - ${`${hours} hours`}::interval`))
    .orderBy(desc(sql`coalesce(${geoSignals.publishedAt}, ${geoSignals.firstSeenAt})`))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    theater: r.theater as Theater,
    at: r.publishedAt ?? r.firstSeenAt,
  }));
}

export interface GeoHealth {
  lastRunAt: Date | null;
  lastStatus: string | null;
  pushedToday: number;
  seenToday: number;
}

export async function geoHealth(): Promise<GeoHealth> {
  const [lastRun] = await db
    .select({ startedAt: geoMonitorRuns.startedAt, status: geoMonitorRuns.status })
    .from(geoMonitorRuns)
    .orderBy(desc(geoMonitorRuns.startedAt))
    .limit(1);

  const [counts] = await db
    .select({
      pushed: sql<number>`count(*) filter (where ${geoSignals.notifiedAt} is not null and ${geoSignals.firstSeenAt} > now() - interval '24 hours')::int`,
      seen: sql<number>`count(*) filter (where ${geoSignals.firstSeenAt} > now() - interval '24 hours')::int`,
    })
    .from(geoSignals);

  return {
    lastRunAt: lastRun?.startedAt ?? null,
    lastStatus: lastRun?.status ?? null,
    pushedToday: counts?.pushed ?? 0,
    seenToday: counts?.seen ?? 0,
  };
}
