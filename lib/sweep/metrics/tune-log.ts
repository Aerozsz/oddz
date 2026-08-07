import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TuneEntry } from "../agent/autotune";

/**
 * Every change to a cap, whoever made it, append-only.
 *
 * This file is what makes the tuner accountable rather than merely automatic.
 * It serves three jobs that all need the same record:
 *
 *  - **The spacing clock.** A setting cannot move again until enough new closes
 *    have happened, and "enough" is measured against the trade count recorded
 *    here. Keeping that in memory would mean a restart hands every dial a fresh
 *    budget, which turns the rate limit into a suggestion.
 *  - **Hysteresis.** Reversing a recent change requires stronger evidence, and
 *    the direction of the last change is only knowable from here.
 *  - **Deference.** Operator edits are written here too, so the tuner can see
 *    that a human touched a dial and leave it alone for a while. Without that
 *    it would override a deliberate change within a trade or two, which is how
 *    an operator learns to distrust the whole mechanism.
 *
 * Append-only for the same reason the trade log is: a record a later process
 * can rewrite is not evidence, and the first entries to disappear would be the
 * ones a bad run made embarrassing.
 */

const LOG_PATH = () => resolve(process.env.SWEEP_TUNE_LOG ?? "data/sweep-tuning.jsonl");

export function appendTune(entry: TuneEntry, path = LOG_PATH()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Never let bookkeeping stop trading — but note that a failure here means
    // the next pass sees no history and therefore no spacing. That is why the
    // caller treats a write failure as a reason not to apply the change.
  }
}

/** True when the entry is safely on disk. The caller gates the change on it. */
export function appendTuneChecked(entry: TuneEntry, path = LOG_PATH()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function loadTuning(path = LOG_PATH()): { entries: TuneEntry[]; skipped: number; path: string } {
  if (!existsSync(path)) return { entries: [], skipped: 0, path };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { entries: [], skipped: 0, path };
  }
  const entries: TuneEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as TuneEntry;
      // An entry without a setting or a trade count cannot serve either of the
      // jobs above, and counting it would make the history look longer than the
      // evidence in it.
      if (!parsed?.setting || typeof parsed.tradesAt !== "number") {
        skipped++;
        continue;
      }
      entries.push(parsed);
    } catch {
      skipped++;
    }
  }
  entries.sort((a, b) => a.at - b.at);
  return { entries, skipped, path };
}

export const tuneLogPath = LOG_PATH;
