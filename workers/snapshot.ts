import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db/client";
import { markets, priceSnapshots, snapshotRuns } from "../lib/db/schema";
import { reconcileEvents } from "../lib/normalize/matcher";
import { log } from "../lib/logger";
import { allSources, type MarketSource, type NormalizedMarket } from "../lib/sources";

export interface SnapshotResult {
  runId: number;
  perVenue: Record<string, { fetched: number; written: number; truncated?: boolean; error?: string }>;
  reconciled: { matched: number; fuzzyMatched: number; created: number };
  durationMs: number;
}

// Deep enough to cover the bulk of each venue's live book. `truncated` is
// logged when a venue still has more pages at the cap, so silent coverage
// gaps surface instead of hiding. Overridable via env for prod tuning.
const PAGES_PER_VENUE = Number(process.env.SNAPSHOT_PAGES_PER_VENUE) || 15;
const PAGE_SIZE = 200;
// Soft wall-clock budget so we never blow past the serverless maxDuration
// (300s on Vercel). 210s of fetching leaves headroom for reconcile + the
// final DB writes even when every venue runs slow.
const TIME_BUDGET_MS = Number(process.env.SNAPSHOT_TIME_BUDGET_MS) || 210_000;
// Reconcile needs meaningful time to be worth starting; below this we skip
// it (the next run picks it up) rather than risk the hard kill.
const RECONCILE_MIN_MS = 20_000;

export async function runSnapshot(): Promise<SnapshotResult> {
  const start = Date.now();
  const [{ id: runId }] = await db
    .insert(snapshotRuns)
    .values({ status: "running" })
    .returning({ id: snapshotRuns.id });

  const deadline = start + TIME_BUDGET_MS;
  const perVenue: SnapshotResult["perVenue"] = {};
  try {
    const results = await Promise.allSettled(allSources.map((s) => fetchVenue(s, deadline)));

    for (let i = 0; i < allSources.length; i++) {
      const venue = allSources[i].venue;
      const r = results[i];
      if (r.status === "fulfilled") perVenue[venue] = r.value;
      else perVenue[venue] = { fetched: 0, written: 0, error: String(r.reason) };
    }

    let reconciled = { matched: 0, fuzzyMatched: 0, created: 0 };
    const reconcileBudget = start + TIME_BUDGET_MS + 60_000 - Date.now();
    if (reconcileBudget >= RECONCILE_MIN_MS) {
      reconciled = await reconcileEvents().catch((err) => {
        log.error("reconcile failed", { error: String(err) });
        return { matched: 0, fuzzyMatched: 0, created: 0 };
      });
    } else {
      log.warn("reconcile skipped, out of time budget", { remainingMs: reconcileBudget });
    }

    const durationMs = Date.now() - start;
    await db
      .update(snapshotRuns)
      .set({ status: "ok", finishedAt: new Date(), stats: perVenue })
      .where(eq(snapshotRuns.id, runId));

    log.info("snapshot complete", { runId, durationMs, perVenue, reconciled });
    return { runId, perVenue, reconciled, durationMs };
  } catch (err) {
    // Never leave the run stuck in "running" — the status page reads this.
    await db
      .update(snapshotRuns)
      .set({ status: "error", finishedAt: new Date(), stats: perVenue })
      .where(eq(snapshotRuns.id, runId))
      .catch(() => {});
    throw err;
  }
}

async function fetchVenue(
  source: MarketSource,
  deadline: number,
): Promise<{ fetched: number; written: number; truncated?: boolean }> {
  const venueLog = log.child({ venue: source.venue });
  let cursor: string | undefined;
  let fetched = 0;
  let written = 0;
  let truncated = false;

  for (let page = 0; page < PAGES_PER_VENUE; page++) {
    // Budget check BEFORE issuing the request — a slow venue must stop
    // spending, not discover it's overdrawn afterwards.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      truncated = true;
      venueLog.warn("venue coverage truncated", { fetched, page, timeout: true });
      break;
    }
    let rows: NormalizedMarket[];
    let nextCursor: string | undefined;
    try {
      // The signal caps this page (fetch + retries) at the remaining budget,
      // so in-flight work dies at the deadline instead of overrunning it.
      ({ markets: rows, nextCursor } = await source.fetchPage({
        limit: PAGE_SIZE,
        cursor,
        signal: AbortSignal.timeout(remaining),
      }));
    } catch (err) {
      // Deadline hit mid-page: keep what we already persisted as a partial
      // (truncated) result instead of failing the whole venue.
      if (Date.now() >= deadline) {
        truncated = true;
        venueLog.warn("venue coverage truncated", { fetched, page, timeout: true });
        break;
      }
      throw err;
    }
    fetched += rows.length;
    if (rows.length > 0) written += await persist(rows);
    if (!nextCursor) break;
    cursor = nextCursor;
    // More pages exist but we've hit the page cap: record it so the
    // coverage gap is visible, never silent.
    if (page === PAGES_PER_VENUE - 1) {
      truncated = true;
      venueLog.warn("venue coverage truncated", { fetched, page: page + 1, timeout: false });
      break;
    }
  }

  venueLog.info("venue fetched", { fetched, written, truncated });
  return { fetched, written, ...(truncated ? { truncated } : {}) };
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
