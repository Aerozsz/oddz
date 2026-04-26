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
