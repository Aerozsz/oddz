/**
 * The monitor loop. Runs on every cron tick:
 *
 *   fetch (all sources, concurrent, time-budgeted)
 *     → classify (foundry gate + severity + direction)
 *       → filter (relevant only)
 *         → persist (dedupe on a deterministic id; new rows only)
 *           → notify (new rows at/above the severity threshold)
 *
 * Two properties matter for a monitor you actually trust:
 *   - Isolation: a degraded source can only truncate its own coverage; the
 *     run still completes and the other sources still fire.
 *   - Exactly-once push: dedupe is a DB upsert with `onConflictDoNothing`, so
 *     the *returned* rows are strictly the ones we hadn't seen — a re-poll of
 *     the same headline never double-pushes.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { intcMonitorRuns, intcNews } from "../db/schema";
import { env } from "../env";
import { log } from "../logger";
import { classify } from "./classify";
import { notify } from "./notify";
import { newsSources } from "./sources";
import { SEVERITY_RANK, type ClassifiedNewsItem, type RawNewsItem, type Severity } from "./types";

export interface MonitorResult {
  runId: number;
  fetched: number;
  relevant: number;
  inserted: number;
  notified: number;
  perSource: Record<string, { fetched: number; error?: string }>;
  durationMs: number;
}

// Soft wall-clock budget, well under the route's maxDuration. Sources run
// concurrently, so this is mostly a guard against one hung feed.
const TIME_BUDGET_MS = Number(process.env.INTC_TIME_BUDGET_MS) || 25_000;
// Only look back a few days on each run — the dedupe key stops repeats, this
// just keeps us from reclassifying ancient items every minute.
const LOOKBACK_MS = Number(process.env.INTC_LOOKBACK_MS) || 3 * 24 * 3600_000;

function itemId(sourceSlug: string, item: RawNewsItem): string {
  // Normalize the URL (drop tracking query/hash) so the same story from two
  // polls — or two feeds — collapses to one row.
  let key = item.externalId || item.url;
  try {
    const u = new URL(item.url);
    key = `${u.origin}${u.pathname}`;
  } catch {
    /* non-URL externalId (e.g. SEC accession) — use as-is */
  }
  return createHash("sha256").update(`${sourceSlug}|${key}`).digest("hex").slice(0, 32);
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export async function runMonitor(): Promise<MonitorResult> {
  const start = Date.now();
  const [{ id: runId }] = await db
    .insert(intcMonitorRuns)
    .values({ status: "running" })
    .returning({ id: intcMonitorRuns.id });

  const deadline = start + TIME_BUDGET_MS;
  const since = new Date(start - LOOKBACK_MS);
  const perSource: MonitorResult["perSource"] = {};

  try {
    const settled = await Promise.allSettled(
      newsSources.map((s) =>
        s.fetch({ signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())), since }),
      ),
    );

    const raw: Array<{ slug: string; item: RawNewsItem }> = [];
    newsSources.forEach((s, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        perSource[s.slug] = { fetched: r.value.length };
        for (const item of r.value) raw.push({ slug: s.slug, item });
      } else {
        perSource[s.slug] = { fetched: 0, error: String(r.reason) };
        log.warn("intc source failed", { source: s.slug, error: String(r.reason) });
      }
    });

    // Classify + keep only foundry-relevant items.
    const classified: ClassifiedNewsItem[] = [];
    for (const { slug, item } of raw) {
      const c = classify(item);
      const relevant = c.relevant || item.forceRelevant === true;
      if (!relevant) continue;
      const severity = item.floorSeverity ? maxSeverity(c.severity, item.floorSeverity) : c.severity;
      classified.push({
        ...item,
        ...c,
        relevant: true,
        severity,
        id: itemId(slug, item),
        sourceSlug: slug,
      });
    }

    // De-dupe within this batch (two feeds, same story) before the DB insert.
    const byId = new Map<string, ClassifiedNewsItem>();
    for (const c of classified) if (!byId.has(c.id)) byId.set(c.id, c);
    const unique = [...byId.values()];

    // Insert; onConflictDoNothing means `returning` yields ONLY rows that were
    // genuinely new — our exactly-once gate for pushing.
    let insertedRows: { id: string }[] = [];
    if (unique.length > 0) {
      insertedRows = await db
        .insert(intcNews)
        .values(
          unique.map((c) => ({
            id: c.id,
            sourceSlug: c.sourceSlug,
            sourceLabel: c.sourceLabel,
            title: c.title,
            url: c.url,
            summary: c.summary ?? null,
            severity: c.severity,
            direction: c.direction,
            score: c.score,
            tags: c.tags,
            publishedAt: c.publishedAt ?? null,
          })),
        )
        .onConflictDoNothing({ target: intcNews.id })
        .returning({ id: intcNews.id });
    }
    const insertedIds = new Set(insertedRows.map((r) => r.id));
    const newItems = unique.filter((c) => insertedIds.has(c.id));

    // Push the new items that clear the threshold; stamp notifiedAt so the
    // feed can show what was pushed vs merely recorded.
    const threshold = SEVERITY_RANK[env().INTC_MIN_SEVERITY];
    let notified = 0;
    for (const item of newItems) {
      if (SEVERITY_RANK[item.severity] < threshold) continue;
      await notify(item);
      notified++;
      await db
        .update(intcNews)
        .set({ notifiedAt: new Date() })
        .where(eq(intcNews.id, item.id))
        .catch(() => {});
    }

    const durationMs = Date.now() - start;
    const result: MonitorResult = {
      runId,
      fetched: raw.length,
      relevant: unique.length,
      inserted: newItems.length,
      notified,
      perSource,
      durationMs,
    };

    await db
      .update(intcMonitorRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        fetched: raw.length,
        relevant: unique.length,
        inserted: newItems.length,
        notified,
        stats: perSource,
      })
      .where(eq(intcMonitorRuns.id, runId));

    log.info("intc monitor complete", { ...result });
    return result;
  } catch (err) {
    await db
      .update(intcMonitorRuns)
      .set({ status: "error", finishedAt: new Date(), stats: perSource })
      .where(eq(intcMonitorRuns.id, runId))
      .catch(() => {});
    throw err;
  }
}
