import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { alertRules } from "@/lib/db/schema";

export interface AlertRuleRow {
  id: number;
  marketId: string;
  question: string;
  venue: string;
  kind: "price_above" | "price_below" | "move_24h";
  threshold: number;
  triggeredAt: Date | null;
  triggeredValue: number | null;
  /** Latest YES price for the rule's market (null if no snapshot). */
  currentYes: number | null;
}

/**
 * Load a watcher's rules and lazily evaluate them against the latest
 * snapshots. Evaluation is one-shot: a rule that fires stays "triggered"
 * (with the value that fired it) until the user re-arms it. Evaluating on
 * page view keeps this off the snapshot cron's time budget; a future email
 * digest can reuse exactly this query server-side.
 */
export async function listAndEvaluateAlerts(wid: string | null): Promise<AlertRuleRow[]> {
  if (!wid) return [];

  // One round trip: rules + latest YES + YES ~24h ago per rule market.
  const rows = await db.execute<{
    id: number;
    market_id: string;
    question: string;
    venue: string;
    kind: AlertRuleRow["kind"];
    threshold: number;
    triggered_at: Date | null;
    triggered_value: number | null;
    yes_now: number | null;
    yes_then: number | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (market_id) market_id, (prices->>0)::float AS yes
      FROM price_snapshots
      WHERE market_id IN (SELECT market_id FROM alert_rules WHERE watcher_id = ${wid})
      ORDER BY market_id, taken_at DESC
    ),
    day_ago AS (
      SELECT DISTINCT ON (market_id) market_id, (prices->>0)::float AS yes
      FROM price_snapshots
      WHERE market_id IN (SELECT market_id FROM alert_rules WHERE watcher_id = ${wid})
        AND taken_at <= now() - interval '24 hours'
      ORDER BY market_id, taken_at DESC
    )
    SELECT r.id, r.market_id, m.question, m.venue_slug AS venue, r.kind, r.threshold,
           r.triggered_at, r.triggered_value, l.yes AS yes_now, d.yes AS yes_then
    FROM alert_rules r
    JOIN markets m ON m.id = r.market_id
    LEFT JOIN latest l ON l.market_id = r.market_id
    LEFT JOIN day_ago d ON d.market_id = r.market_id
    WHERE r.watcher_id = ${wid}
    ORDER BY r.created_at DESC
  `);

  const out: AlertRuleRow[] = [];
  const fired: { id: number; value: number }[] = [];

  for (const r of rows.rows) {
    const yesNow = r.yes_now === null ? null : Number(r.yes_now);
    const yesThen = r.yes_then === null ? null : Number(r.yes_then);
    let triggeredAt = r.triggered_at;
    let triggeredValue = r.triggered_value === null ? null : Number(r.triggered_value);

    if (!triggeredAt && yesNow !== null) {
      const threshold = Number(r.threshold);
      const hit =
        (r.kind === "price_above" && yesNow >= threshold) ||
        (r.kind === "price_below" && yesNow <= threshold) ||
        (r.kind === "move_24h" && yesThen !== null && Math.abs(yesNow - yesThen) >= threshold);
      if (hit) {
        triggeredAt = new Date();
        triggeredValue = yesNow;
        fired.push({ id: Number(r.id), value: yesNow });
      }
    }

    out.push({
      id: Number(r.id),
      marketId: r.market_id,
      question: r.question,
      venue: r.venue,
      kind: r.kind,
      threshold: Number(r.threshold),
      triggeredAt,
      triggeredValue,
      currentYes: yesNow,
    });
  }

  // Persist newly-fired rules (small N; sequential is fine).
  for (const f of fired) {
    await db
      .update(alertRules)
      .set({ triggeredAt: new Date(), triggeredValue: f.value })
      .where(eq(alertRules.id, f.id));
  }

  return out;
}
