/**
 * The geo monitor loop — same shape as the INTC monitor:
 *   fetch → classify (side/theater/intensity) → dedupe → persist → notify.
 * Isolation and exactly-once push carry over unchanged: a degraded source
 * truncates only itself, and the insert's `onConflictDoNothing` returning set
 * is exactly the never-seen rows, so a re-poll never double-pushes.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { geoMonitorRuns, geoSignals } from "../db/schema";
import { env } from "../env";
import { log } from "../logger";
import { classify } from "./classify";
import { notifyGeo } from "./notify";
import { geoSources } from "./sources";
import { INTENSITY_RANK, type ClassifiedGeoItem, type RawGeoItem } from "./types";

export interface GeoMonitorResult {
  runId: number;
  fetched: number;
  relevant: number;
  inserted: number;
  notified: number;
  perSource: Record<string, { fetched: number; error?: string }>;
  durationMs: number;
}

const TIME_BUDGET_MS = Number(process.env.GEO_TIME_BUDGET_MS) || 25_000;
const LOOKBACK_MS = Number(process.env.GEO_LOOKBACK_MS) || 3 * 24 * 3600_000;

function itemId(sourceSlug: string, item: RawGeoItem): string {
  let key = item.externalId || item.url;
  try {
    const u = new URL(item.url);
    key = `${u.origin}${u.pathname}`;
  } catch {
    /* non-URL id — use as-is */
  }
  return createHash("sha256").update(`${sourceSlug}|${key}`).digest("hex").slice(0, 32);
}

export async function runGeoMonitor(): Promise<GeoMonitorResult> {
  const start = Date.now();
  const [{ id: runId }] = await db
    .insert(geoMonitorRuns)
    .values({ status: "running" })
    .returning({ id: geoMonitorRuns.id });

  const deadline = start + TIME_BUDGET_MS;
  const since = new Date(start - LOOKBACK_MS);
  const perSource: GeoMonitorResult["perSource"] = {};

  try {
    const settled = await Promise.allSettled(
      geoSources.map((s) =>
        s.fetch({ signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())), since }),
      ),
    );

    const raw: Array<{ slug: string; item: RawGeoItem }> = [];
    geoSources.forEach((s, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        perSource[s.slug] = { fetched: r.value.length };
        for (const item of r.value) raw.push({ slug: s.slug, item });
      } else {
        perSource[s.slug] = { fetched: 0, error: String(r.reason) };
        log.warn("geo source failed", { source: s.slug, error: String(r.reason) });
      }
    });

    const classified: ClassifiedGeoItem[] = [];
    for (const { slug, item } of raw) {
      const c = classify(item);
      if (!c.relevant) continue;
      classified.push({ ...item, ...c, id: itemId(slug, item), sourceSlug: slug });
    }

    const byId = new Map<string, ClassifiedGeoItem>();
    for (const c of classified) if (!byId.has(c.id)) byId.set(c.id, c);
    const unique = [...byId.values()];

    let insertedRows: { id: string }[] = [];
    if (unique.length > 0) {
      insertedRows = await db
        .insert(geoSignals)
        .values(
          unique.map((c) => ({
            id: c.id,
            sourceSlug: c.sourceSlug,
            sourceLabel: c.sourceLabel,
            title: c.title,
            url: c.url,
            summary: c.summary ?? null,
            side: c.side,
            theater: c.theater,
            intensity: c.intensity,
            marketLean: c.marketLean,
            score: c.score,
            tags: c.tags,
            publishedAt: c.publishedAt ?? null,
          })),
        )
        .onConflictDoNothing({ target: geoSignals.id })
        .returning({ id: geoSignals.id });
    }
    const insertedIds = new Set(insertedRows.map((r) => r.id));
    const newItems = unique.filter((c) => insertedIds.has(c.id));

    const threshold = INTENSITY_RANK[env().GEO_MIN_INTENSITY];
    let notified = 0;
    for (const item of newItems) {
      // Only push items that pick a side hard enough to matter; neutral/mixed
      // are recorded for the dashboard but never buzz the phone.
      if (item.side === "neutral") continue;
      if (INTENSITY_RANK[item.intensity] < threshold) continue;
      await notifyGeo(item);
      notified++;
      await db.update(geoSignals).set({ notifiedAt: new Date() }).where(eq(geoSignals.id, item.id)).catch(() => {});
    }

    const durationMs = Date.now() - start;
    const result: GeoMonitorResult = {
      runId,
      fetched: raw.length,
      relevant: unique.length,
      inserted: newItems.length,
      notified,
      perSource,
      durationMs,
    };

    await db
      .update(geoMonitorRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        fetched: raw.length,
        relevant: unique.length,
        inserted: newItems.length,
        notified,
        stats: perSource,
      })
      .where(eq(geoMonitorRuns.id, runId));

    log.info("geo monitor complete", { ...result });
    return result;
  } catch (err) {
    await db
      .update(geoMonitorRuns)
      .set({ status: "error", finishedAt: new Date(), stats: perSource })
      .where(eq(geoMonitorRuns.id, runId))
      .catch(() => {});
    throw err;
  }
}
