import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db/client";
import { markets, priceSnapshots, snapshotRuns } from "../lib/db/schema";
import { reconcileEvents } from "../lib/normalize/matcher";
import { log } from "../lib/logger";
import { allSources, type MarketSource, type NormalizedMarket } from "../lib/sources";

export interface SnapshotResult {
  runId: number;
  perVenue: Record<string, { fetched: number; written: number; error?: string }>;
  reconciled: { matched: number; created: number };
  durationMs: number;
}

const PAGES_PER_VENUE = 3;
const PAGE_SIZE = 200;

export async function runSnapshot(): Promise<SnapshotResult> {
  const start = Date.now();
  const [{ id: runId }] = await db
    .insert(snapshotRuns)
    .values({ status: "running" })
    .returning({ id: snapshotRuns.id });

  const results = await Promise.allSettled(allSources.map((s) => fetchVenue(s)));

  const perVenue: SnapshotResult["perVenue"] = {};
  for (let i = 0; i < allSources.length; i++) {
    const venue = allSources[i].venue;
    const r = results[i];
    if (r.status === "fulfilled") perVenue[venue] = r.value;
    else perVenue[venue] = { fetched: 0, written: 0, error: String(r.reason) };
  }

  const reconciled = await reconcileEvents().catch((err) => {
    log.error("reconcile failed", { error: String(err) });
    return { matched: 0, created: 0 };
  });

  const durationMs = Date.now() - start;
  await db
    .update(snapshotRuns)
    .set({ status: "ok", finishedAt: new Date(), stats: perVenue })
    .where(eq(snapshotRuns.id, runId));

  log.info("snapshot complete", { runId, durationMs, perVenue, reconciled });
  return { runId, perVenue, reconciled, durationMs };
}

async function fetchVenue(source: MarketSource): Promise<{ fetched: number; written: number }> {
  const venueLog = log.child({ venue: source.venue });
  let cursor: string | undefined;
  let fetched = 0;
  let written = 0;

  for (let page = 0; page < PAGES_PER_VENUE; page++) {
    const { markets: rows, nextCursor } = await source.fetchPage({ limit: PAGE_SIZE, cursor });
    fetched += rows.length;
    if (rows.length > 0) written += await persist(rows);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  venueLog.info("venue fetched", { fetched, written });
  return { fetched, written };
}

async function persist(batch: NormalizedMarket[]): Promise<number> {
  // Upsert market rows.
  await db
    .insert(markets)
    .values(
      batch.map((m) => ({
        id: `${m.venue}:${m.externalId}`,
        venueSlug: m.venue,
        externalId: m.externalId,
        slug: m.slug,
        question: m.question,
        description: m.description ?? null,
        category: m.category ?? null,
        outcomes: m.outcomes,
        sourceUrl: m.sourceUrl,
        endsAt: m.endsAt ?? null,
        closed: m.closed ? 1 : 0,
        lastSeenAt: m.fetchedAt,
      })),
    )
    .onConflictDoUpdate({
      target: markets.id,
      set: {
        question: sql`excluded.question`,
        description: sql`excluded.description`,
        category: sql`excluded.category`,
        outcomes: sql`excluded.outcomes`,
        sourceUrl: sql`excluded.source_url`,
        endsAt: sql`excluded.ends_at`,
        closed: sql`excluded.closed`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });

  // Append a snapshot row per market that has prices.
  const snaps = batch
    .filter((m) => m.prices.length > 0)
    .map((m) => ({
      marketId: `${m.venue}:${m.externalId}`,
      takenAt: m.fetchedAt,
      prices: m.prices,
      volume: m.volume ?? null,
      liquidity: m.liquidity ?? null,
      openInterest: m.openInterest ?? null,
    }));

  if (snaps.length > 0) {
    await db.insert(priceSnapshots).values(snaps).onConflictDoNothing();
  }

  return batch.length;
}
