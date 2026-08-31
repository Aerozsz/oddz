/**
 * What the shadow run would have made.
 *
 *   npm run sweep:shadow:report
 *
 * The paper log answers "does this reading predict anything". This answers the
 * narrower and more decisive question: taking these trades, at these sizes,
 * paying these fees, would the account be up.
 *
 * Reported net throughout. A gross figure at this frequency is not an
 * interesting number — a 30bp winner against a 7bp round trip keeps three
 * quarters of itself, and a 10bp winner keeps none.
 */

import { maxOf, minOf } from "../lib/sweep/numeric";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ShadowTrade } from "../lib/sweep/exchange/shadow";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const IN = resolve(arg("in", "data/sweep-shadow.jsonl"));
const HORIZON = arg("horizon", "t900");

if (!existsSync(IN)) {
  console.error(`\n  No shadow log at ${IN}\n`);
  console.error("  Run it first, and leave it running:\n");
  console.error("      npm run sweep:shadow\n");
  console.error("  It needs no credentials and cannot place an order.\n");
  process.exit(1);
}

const trades: ShadowTrade[] = [];
for (const line of readFileSync(IN, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    trades.push(JSON.parse(line) as ShadowTrade);
  } catch {
    /* skip */
  }
}

const scored = trades.filter((t) => typeof t.outcomes?.[HORIZON]?.netUsd === "number");

console.log(`\n  ${IN}`);
console.log(`  ${trades.length} trades, ${scored.length} scored at ${HORIZON}\n`);

if (!scored.length) {
  console.log("  Nothing scored yet. Each trade resolves 15 minutes after it is taken.\n");
  process.exit(0);
}

const net = (t: ShadowTrade) => t.outcomes[HORIZON].netUsd as number;
const gross = (t: ShadowTrade) => net(t) + t.feeUsd + Math.max(0, t.fundingUsd);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const netTotal = sum(scored.map(net));
const grossTotal = sum(scored.map(gross));
const feeTotal = sum(scored.map((t) => t.feeUsd));
const wins = scored.filter((t) => net(t) > 0);
const losses = scored.filter((t) => net(t) <= 0);

const span = (scored[scored.length - 1].at - scored[0].at) / 3_600_000;

console.log(`  covering ${span.toFixed(1)}h — ${(scored.length / Math.max(span / 24, 0.01)).toFixed(1)} trades a day\n`);

const row = (k: string, v: string) => console.log(`    ${k.padEnd(28)}${v}`);
row("gross P&L", `${grossTotal >= 0 ? "+" : ""}${grossTotal.toFixed(2)}`);
row("fees paid", `-${feeTotal.toFixed(2)}`);
row("NET P&L", `${netTotal >= 0 ? "+" : ""}${netTotal.toFixed(2)}`);
row("fees as % of gross", grossTotal > 0 ? `${((feeTotal / grossTotal) * 100).toFixed(0)}%` : "—");
console.log("");
row("win rate (net)", `${((wins.length / scored.length) * 100).toFixed(0)}%  (${wins.length}/${scored.length})`);
row("average win", wins.length ? `+${(sum(wins.map(net)) / wins.length).toFixed(2)}` : "—");
row("average loss", losses.length ? `${(sum(losses.map(net)) / losses.length).toFixed(2)}` : "—");
row("best / worst", `${(maxOf(scored.map(net)) ?? 0).toFixed(2)} / ${(minOf(scored.map(net)) ?? 0).toFixed(2)}`);
console.log("");

// How many would have been stopped out inside the window, which the raw
// horizon price cannot show on its own.
const stopped = scored.filter((t) => t.resolved === "stop").length;
const target = scored.filter((t) => t.resolved === "target").length;
row("hit the stop first", `${stopped} (${((stopped / scored.length) * 100).toFixed(0)}%)`);
row("reached the target", `${target} (${((target / scored.length) * 100).toFixed(0)}%)`);
row("neither", `${scored.length - stopped - target}`);
console.log("");

/* The splits that decide what to change. */
function split(title: string, buckets: [string, ShadowTrade[]][]) {
  console.log(`  ${title}`);
  for (const [label, group] of buckets) {
    if (!group.length) continue;
    const n = sum(group.map(net));
    console.log(
      `    ${label.padEnd(24)}${String(group.length).padStart(5)} trades   ` +
        `net ${(n >= 0 ? "+" : "") + n.toFixed(2)}`.padStart(18) +
        `   avg ${(n / group.length >= 0 ? "+" : "") + (n / group.length).toFixed(2)}`,
    );
  }
  console.log("");
}

split("By entry style", [
  ["rested (maker)", scored.filter((t) => t.style.entry === "maker")],
  ["crossed (taker)", scored.filter((t) => t.style.entry === "taker")],
]);

split("By signal", [...new Set(scored.map((t) => t.signalKind))].map((k) => [k, scored.filter((t) => t.signalKind === k)]));

split("By session phase", [...new Set(scored.map((t) => t.intraday))].map((p) => [p, scored.filter((t) => t.intraday === p)]));

split("By flow toxicity at entry", [
  ["quiet (<0.4)", scored.filter((t) => (t.markoutToxicity ?? 0) < 0.4)],
  ["mid (0.4-0.7)", scored.filter((t) => (t.markoutToxicity ?? 0) >= 0.4 && (t.markoutToxicity ?? 0) < 0.7)],
  ["toxic (>=0.7)", scored.filter((t) => (t.markoutToxicity ?? 0) >= 0.7)],
]);

split("By side", [
  ["long", scored.filter((t) => t.side === "long")],
  ["short", scored.filter((t) => t.side === "short")],
]);

console.log("  ─────");
if (scored.length < 30) {
  console.log(`  ${scored.length} trades is not a result. At this frequency a run needs days before`);
  console.log("  the sign of that net figure means anything — a handful of trades is dominated");
  console.log("  by whichever way the market happened to move.");
} else if (netTotal <= 0) {
  console.log("  Net negative. Before changing anything, check the splits above: if one signal or");
  console.log("  one phase is carrying the losses, that is a filter to add rather than evidence");
  console.log("  the whole approach fails.");
} else {
  console.log("  Net positive. The number to watch is fees as a share of gross — if that is above");
  console.log("  a third, the strategy is working and most of it is going to the venue, which is a");
  console.log("  frequency and execution problem rather than a signal problem.");
}
console.log("");
console.log("  This is still a shadow: no order was placed, so no fill was ever refused, no queue");
console.log("  was ever jumped, and nothing moved the book. A real maker entry fills selectively");
console.log("  — you get the ones that were about to go against you — so treat the maker row as");
console.log("  an upper bound rather than an estimate.\n");
