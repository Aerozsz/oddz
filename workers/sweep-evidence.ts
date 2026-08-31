/**
 * Publish what the shadow run knows, without the control server.
 *
 * The summary normally reaches the outside world inside the control server's
 * state snapshot, which means reading it requires a machine running the whole
 * agent — GUI, order path, credentials and all. That was fine while the only
 * host was the operator's laptop, and it is the wrong shape now that the
 * research runs on a CI runner that has no keys, must never place an order, and
 * is deliberately not reachable over the network.
 *
 * So this writes the same summary from the same function to `evidence/`, where
 * git carries it. The runner needs no credentials to produce it, because
 * nothing here touches the account: shadow rows are decisions that were never
 * sent, scored against public prices.
 *
 * Deliberately a separate worker rather than a flag on the control server. A
 * process that can trade and a process that cannot are worth keeping apart when
 * one of them is going to run unattended for six hours at a time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { summariseShadow, type ShadowRowLike } from "../lib/sweep/agent/shadow-summary";

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const IN = resolve(arg("in", process.env.SWEEP_SHADOW_OUT ?? "data/sweep-shadow.jsonl"));
const OUT = resolve(arg("out", "evidence/shadow-summary.json"));

function read(): ShadowRowLike[] {
  if (!existsSync(IN)) return [];
  const rows: ShadowRowLike[] = [];
  for (const line of readFileSync(IN, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // The last line of a file being appended to is routinely half-written.
    try {
      rows.push(JSON.parse(line) as ShadowRowLike);
    } catch {
      /* partial */
    }
  }
  return rows;
}

function main() {
  const rows = read();
  /*
   * An empty file is written out as an empty summary rather than skipped.
   *
   * A missing output file and a summary of zero rows look the same from a git
   * log, and they are opposite situations: one means the collector never ran,
   * the other means it ran and the market gave it nothing. This project has
   * lost days to that distinction twice.
   */
  const summary = {
    at: Date.now(),
    source: IN,
    rows: rows.length,
    ...(rows.length === 0
      ? { note: "the shadow log is empty or absent — the collector has not written a row yet, which is not the same as a run that found nothing" }
      : {}),
    summary: summariseShadow(rows),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`[evidence] ${rows.length} row(s) -> ${OUT}`);
}

main();
