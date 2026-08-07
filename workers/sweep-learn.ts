/**
 * What the losses have in common.
 *
 *   npm run sweep:learn
 *
 * Reads the trade log the control server writes on every close and prints the
 * post-mortem: how the losses failed, whether any entry condition separates
 * them from the winners, and what to change. Nothing here places an order,
 * touches the limits file, or contacts an exchange — it reads one file and
 * prints.
 *
 * The recommendations are addressed to a person on purpose. An auto-tuner
 * reading forty trades fits the last week and trades the next one on it, and it
 * does that most eagerly during the drawdown that made the sample
 * unrepresentative — which is exactly when the parameters are least worth
 * moving.
 */

import { loadEnv } from "./load-env";
import { loadTrades } from "../lib/sweep/metrics/trade-log";
import { analyse, classifyLoss, recommendations, rMultiple } from "../lib/sweep/agent/learn";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnv();

const LIMITS_PATH = resolve(process.env.SWEEP_LIMITS ?? "data/sweep-limits.json");

function currentLimits() {
  const fallback = { breakEvenAtPct: 60, stopLossPct: 0.5, maxHoldMinutes: 30, riskPerTradePct: 4 };
  if (!existsSync(LIMITS_PATH)) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(LIMITS_PATH, "utf8")) as Record<string, number>) };
  } catch {
    return fallback;
  }
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const bar = (n: number) => "".padEnd(n, "─");

const { records, skipped, path } = loadTrades();

console.log("");
if (records.length === 0) {
  console.log(`  No closed trades recorded yet.`);
  console.log(`  The control server writes to ${path} as each position closes.`);
  console.log("");
  process.exit(0);
}

const only = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1]?.toUpperCase();
const trades = only ? records.filter((t) => t.symbol === only) : records;
if (only && trades.length === 0) {
  console.log(`  No closed trades recorded for ${only}.`);
  console.log("");
  process.exit(0);
}

const report = analyse(trades);

console.log(`  ${bar(74)}`);
console.log(`  TRADE POST-MORTEM${only ? ` — ${only}` : ""}`);
console.log(`  ${path}${skipped > 0 ? `  (${skipped} unreadable line${skipped === 1 ? "" : "s"} skipped)` : ""}`);
console.log(`  ${bar(74)}`);
console.log("");
for (const line of report.lines.slice(0, 2)) console.log(`  ${line}`);
console.log("");

/* --------------------------------------------------------------- anatomy */

console.log(`  HOW THE LOSSES FAILED`);
console.log(`  ${bar(74)}`);
if (report.anatomy.length === 0) {
  console.log("  No losing trades recorded yet.");
} else {
  for (const a of report.anatomy) {
    console.log("");
    console.log(
      `  ${pad(a.kind, 18)} ${a.count} trade${a.count === 1 ? "" : "s"}  ` +
        `${(a.share * 100).toFixed(0)}% of losses  -$${a.costUsd.toFixed(2)}`,
    );
    for (const line of wrap(a.prescription, 70)) console.log(`      ${line}`);
    for (const ex of a.examples) console.log(`      · ${ex}`);
  }
}
console.log("");

/* ------------------------------------------------------------ conditions */

console.log(`  WHAT THE CONDITIONS SAY`);
console.log(`  ${bar(74)}`);
if (report.splits.length === 0) {
  console.log(`  Not enough trades on both sides of any condition to compare yet.`);
} else {
  for (const s of report.splits.slice(0, 12)) {
    console.log("");
    console.log(`  ${s.label}${s.decisive ? "   ← worth acting on" : ""}`);
    for (const arm of s.arms) {
      const r = arm.r.n >= 2 ? `${arm.r.mean >= 0 ? "+" : ""}${arm.r.mean.toFixed(2)}R` : "  –  ";
      console.log(
        `      ${pad(arm.label, 22)} n=${pad(String(arm.n), 4)} ` +
          `won ${pad(`${(arm.winRate * 100).toFixed(0)}%`, 5)} ` +
          `(${(arm.winLo * 100).toFixed(0)}–${(arm.winHi * 100).toFixed(0)}%)  ${r}`,
      );
    }
    for (const line of wrap(s.note, 70)) console.log(`      ${line}`);
  }
}
console.log("");

/* -------------------------------------------------------- what to change */

const recs = recommendations(report, currentLimits());
console.log(`  WHAT TO CHANGE`);
console.log(`  ${bar(74)}`);
if (recs.length === 0) {
  console.log(`  Nothing yet. Either the losses do not concentrate in one failure mode,`);
  console.log(`  or there are too few of them to tell — both mean the next useful thing`);
  console.log(`  is more trades rather than a parameter moved on a guess.`);
} else {
  for (const r of recs) {
    console.log("");
    const change =
      r.suggested !== null && r.current !== null ? `  ${r.current} → ${r.suggested}` : "";
    console.log(`  ${r.setting}${change}   [${r.support}]`);
    for (const line of wrap(r.why, 70)) console.log(`      ${line}`);
  }
}
console.log("");

/* ------------------------------------------------------- what this is not */

console.log(`  WHAT THIS DOES NOT SHOW`);
console.log(`  ${bar(74)}`);
for (const c of report.caveats) {
  for (const line of wrap(c, 72)) console.log(`  ${line}`);
  console.log("");
}

if (process.argv.includes("--trades")) {
  console.log(`  EVERY TRADE`);
  console.log(`  ${bar(74)}`);
  for (const t of trades) {
    const r = rMultiple(t);
    console.log(
      `  ${new Date(t.closedAt).toISOString().slice(0, 16).replace("T", " ")} ` +
        `${pad(t.symbol, 10)} ${pad(t.side, 6)} ${pad(t.outcome, 8)} ` +
        `${pad(r === null ? "–" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`, 8)} ` +
        `${pad(`${Math.round(t.heldMs / 60_000)}m`, 6)} ` +
        `best +${t.mfePct.toFixed(3)}% worst ${t.maePct.toFixed(3)}%`,
    );
    console.log(`      ${t.outcome === "loss" ? classifyLoss(t).detail : t.exitReason}`);
  }
  console.log("");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
