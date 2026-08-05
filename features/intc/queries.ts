import { desc, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { intcMonitorRuns, intcNews } from "@/lib/db/schema";

export interface FeedItem {
  id: string;
  sourceLabel: string;
  title: string;
  url: string;
  summary: string | null;
  severity: "low" | "medium" | "high" | "critical";
  direction: "bullish" | "bearish" | "neutral";
  score: number;
  tags: string[];
  publishedAt: Date | null;
  firstSeenAt: Date;
  notifiedAt: Date | null;
}

/** Most recent catalysts, newest first. */
export async function recentCatalysts(limit = 60): Promise<FeedItem[]> {
  const rows = await db
    .select({
      id: intcNews.id,
      sourceLabel: intcNews.sourceLabel,
      title: intcNews.title,
      url: intcNews.url,
      summary: intcNews.summary,
      severity: intcNews.severity,
      direction: intcNews.direction,
      score: intcNews.score,
      tags: intcNews.tags,
      publishedAt: intcNews.publishedAt,
      firstSeenAt: intcNews.firstSeenAt,
      notifiedAt: intcNews.notifiedAt,
    })
    .from(intcNews)
    .orderBy(desc(sql`coalesce(${intcNews.publishedAt}, ${intcNews.firstSeenAt})`))
    .limit(limit);
  return rows;
}

export interface MonitorHealth {
  lastRunAt: Date | null;
  lastStatus: string | null;
  pushedToday: number;
  seenToday: number;
}

/** Heartbeat + today's counts for the page header. */
export async function monitorHealth(): Promise<MonitorHealth> {
  const [lastRun] = await db
    .select({ startedAt: intcMonitorRuns.startedAt, status: intcMonitorRuns.status })
    .from(intcMonitorRuns)
    .orderBy(desc(intcMonitorRuns.startedAt))
    .limit(1);

  const [counts] = await db
    .select({
      pushed: sql<number>`count(*) filter (where ${intcNews.notifiedAt} is not null and ${intcNews.firstSeenAt} > now() - interval '24 hours')::int`,
      seen: sql<number>`count(*) filter (where ${intcNews.firstSeenAt} > now() - interval '24 hours')::int`,
    })
    .from(intcNews);

  return {
    lastRunAt: lastRun?.startedAt ?? null,
    lastStatus: lastRun?.status ?? null,
    pushedToday: counts?.pushed ?? 0,
    seenToday: counts?.seen ?? 0,
  };
}
