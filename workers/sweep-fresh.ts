/**
 * Start the performance figures again, without destroying the evidence.
 *
 *   npm run sweep:fresh            # says what it would do
 *   npm run sweep:fresh -- --yes   # does it
 *
 * The live trade log accumulated 59 closed trades at a 3% win rate, and every
 * one of them measured a bug rather than the strategy: a cluster map pointing at
 * the current price, entries taken on books that were never thin, a hold engine
 * cutting positions at zero movement, and a trade cap that had been switched off
 * being switched back on. Those records are not a weak result, they are a
 * measurement of code that no longer exists.
 *
 * Left in place they do active harm. The post-mortem reports a win rate that
 * describes fixed bugs, the auto-tuner reads its evidence from the same file,
 * and anyone — human or otherwise — looking at the page draws conclusions from
 * a sample that cannot support them.
 *
 * ## Archived, never deleted
 *
 * The bugs are documented in that data and the record of what was wrong is worth
 * keeping. Everything moves to `data/archive/` with a timestamp, so the forensics
 * survive while the learning loop starts from nothing.
 *
 * ## What is deliberately kept
 *
 * The shadow log, the evidence log and the tuning audit. Shadow trades are
 * price-derived rather than fill-derived, so most of them remain admissible for
 * the questions they were collected to answer; the evidence log samples market
 * state on a clock and is unaffected by any of this; and the tuning log is
 * append-only on purpose, because a record of setting changes that can be
 * rewritten is not a record.
 *
 * Risk limits are not touched. They are operator input.
 */

import { existsSync, mkdirSync, renameSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { loadEnv } from "./load-env";
import { ledgerPath, rebaseNow, writeEpoch } from "../lib/sweep/exchange/ledger";

loadEnv();

const confirmed = process.argv.includes("--yes");

const tradeLog = resolve(process.env.SWEEP_TRADE_LOG ?? "data/sweep-trades.jsonl");
const journal = resolve(process.env.SWEEP_JOURNAL ?? "data/sweep-positions.json");

/** Moved out of the way. */
const ARCHIVE: { path: string; what: string }[] = [
  { path: tradeLog, what: "closed-trade post-mortems — the win rate, expectancy and loss anatomy" },
  { path: journal, what: "what this process remembered about open positions" },
];

/** Left exactly where it is, and why. */
const KEPT: [string, string][] = [
  [process.env.SWEEP_SHADOW_OUT ?? "data/sweep-shadow.jsonl",
    "shadow trades — price-derived, so still admissible for entry quality and exit geometry"],
  [process.env.SWEEP_PAPER_OUT ?? "data/sweep-paper.jsonl",
    "the evidence log — market-state samples, unaffected by any of the execution bugs"],
  [process.env.SWEEP_TUNE_LOG ?? "data/sweep-tuning.jsonl",
    "the tuning audit — append-only by design; a rewritable record of changes is not a record"],
  [process.env.SWEEP_NEWS ?? "data/sweep-news.json", "collected headlines"],
  [process.env.SWEEP_LIMITS ?? "data/sweep-limits.json", "your risk settings — never touched by this"],
  [process.env.SWEEP_SYMBOLS_FILE ?? "data/sweep-symbols.json", "the contracts you picked"],
];

const rows = (n: number) => (n === 1 ? "1 row" : `${n} rows`);

function countRows(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const archiveDir = resolve(dirname(tradeLog), "archive");

console.error("");
console.error("  Starting the performance figures again.");
console.error("");
console.error("  MOVED to data/archive/ — kept, but no longer read by anything:");
let anyToMove = false;
for (const { path, what } of ARCHIVE) {
  if (!existsSync(path)) {
    console.error(`    · ${basename(path)} — not present`);
    continue;
  }
  anyToMove = true;
  const n = countRows(path);
  const kb = Math.round(statSync(path).size / 102.4) / 10;
  console.error(`    · ${basename(path)}  (${rows(n)}, ${kb}kB) — ${what}`);
}

console.error("");
console.error("  KEPT:");
for (const [p, why] of KEPT) {
  const full = resolve(p);
  const mark = existsSync(full) ? `${rows(countRows(full))}` : "not present";
  console.error(`    · ${basename(full)}  (${mark}) — ${why}`);
}

console.error("");
console.error("  ALSO: today's P&L, trade count and cooldown restart from now.");
console.error("        Those are read from Binance's income ledger, not from any file here,");
console.error("        so they are reset by moving where the counting starts.");
console.error("");

if (!confirmed) {
  console.error("  Nothing has been changed. Run it again with --yes to do it:");
  console.error("");
  console.error("      npm run sweep:fresh -- --yes");
  console.error("");
  process.exit(0);
}

if (anyToMove) mkdirSync(archiveDir, { recursive: true });
for (const { path } of ARCHIVE) {
  if (!existsSync(path)) continue;
  const dest = resolve(archiveDir, `${basename(path, ".jsonl").replace(/\.json$/, "")}-${stamp}${path.endsWith(".jsonl") ? ".jsonl" : ".json"}`);
  renameSync(path, dest);
  console.error(`  moved  ${basename(path)} → archive/${basename(dest)}`);
}

/*
 * The day counters come from the exchange, so the only way to restart them is
 * to move the epoch the ledger is read from. Balance is left at zero here
 * deliberately: the control server observes the real one on its next sweep and
 * the epoch is what matters.
 */
// Reason set explicitly rather than inheriting the dashboard's, so the ledger
// file says which action moved it.
const epoch = rebaseNow(0, Date.now(), ledgerPath());
epoch.reason = "restarted by sweep:fresh";
writeEpoch(epoch, ledgerPath());
console.error(`  today's counting now starts at ${new Date(epoch.epoch).toLocaleTimeString()}`);

console.error("");
console.error("  Done. Restart the control server so it reads the new state:");
console.error("");
console.error("      npm run sweep:control");
console.error("");
