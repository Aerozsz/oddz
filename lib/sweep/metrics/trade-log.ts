import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TradeRecord } from "../agent/postmortem";

/**
 * Every closed trade, on disk, one JSON object per line.
 *
 * Append-only and never rewritten, which is the whole design. The point of this
 * file is to be evidence, and evidence that a later process can edit is not
 * evidence — the moment a "cleanup" pass can drop rows, the first rows to go
 * are the embarrassing ones, and the record starts agreeing with whatever the
 * strategy currently believes.
 *
 * JSONL rather than a table because the interesting failure is a crash
 * mid-write, and a torn last line costs exactly one trade here instead of the
 * whole file. The reader drops unparseable lines and says how many it dropped
 * rather than throwing, for the same reason: an analysis that refuses to run
 * because of one bad row is an analysis nobody runs.
 *
 * The database would be the obvious home and is deliberately not used. This has
 * to work on a laptop with the control server running and nothing else, and it
 * has to keep working when Postgres is unreachable — a trade that closed while
 * the database was down is precisely the trade worth having a record of.
 */

const LOG_PATH = () => resolve(process.env.SWEEP_TRADE_LOG ?? "data/sweep-trades.jsonl");

export function appendTrade(record: TradeRecord, path = LOG_PATH()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Never let bookkeeping stop trading. A lost row is a gap in the analysis;
    // a thrown error here would propagate into the position-management sweep,
    // which is the loop that keeps stops resting.
  }
}

export interface LoadedTrades {
  records: TradeRecord[];
  /** Lines that could not be parsed — reported rather than hidden. */
  skipped: number;
  path: string;
}

export function loadTrades(path = LOG_PATH()): LoadedTrades {
  if (!existsSync(path)) return { records: [], skipped: 0, path };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { records: [], skipped: 0, path };
  }

  const records: TradeRecord[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TradeRecord;
      // A row without an outcome or entry conditions cannot be grouped, and a
      // row that cannot be grouped silently distorts every count it appears in.
      if (!parsed || typeof parsed !== "object" || !parsed.entryConditions || !parsed.outcome) {
        skipped++;
        continue;
      }
      records.push(parsed);
    } catch {
      skipped++;
    }
  }
  records.sort((a, b) => a.closedAt - b.closedAt);
  return { records, skipped, path };
}

export const tradeLogPath = LOG_PATH;
