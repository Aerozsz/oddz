import { sql } from "drizzle-orm";
import { db } from "../lib/db/client";
import { log } from "../lib/logger";

const KEEP_FULL_DAYS = 30;

/**
 * Roll up old history: snapshots older than KEEP_FULL_DAYS are thinned
 * to the first snapshot per market per hour. Recent data keeps full
 * 5-minute resolution. Idempotent; safe to run any time.
 */
export async function pruneSnapshots(): Promise<{ deleted: number }> {
  const result = await db.execute(sql`
    DELETE FROM price_snapshots ps
    USING (
      SELECT market_id, taken_at,
             row_number() OVER (
               PARTITION BY market_id, date_trunc('hour', taken_at)
               ORDER BY taken_at ASC
             ) AS rn
      FROM price_snapshots
      WHERE taken_at < now() - make_interval(days => ${KEEP_FULL_DAYS})
    ) dup
    WHERE ps.market_id = dup.market_id
      AND ps.taken_at = dup.taken_at
      AND dup.rn > 1
  `);
  const deleted = result.rowCount ?? 0;
  log.info("snapshot retention pruned", { deleted, keepFullDays: KEEP_FULL_DAYS });
  return { deleted };
}
