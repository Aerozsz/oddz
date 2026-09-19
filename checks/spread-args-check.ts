/**
 * Spreading an array into a call throws once the array gets big.
 *
 * `f(...xs)` passes every element as a separate argument, so it raises
 * `RangeError: Maximum call stack size exceeded` somewhere around 65,000
 * elements — with no warning below that and no partial failure above it. It
 * passes every fixture and every short run, and fails only once real data
 * accumulates, which is the worst possible time.
 *
 * This project has now shipped that bug twice.
 *
 *  - `Math.min(...closes)` in the replay's price-span check. Every research
 *    pass refused for six days with the loop still looking healthy, and
 *    FINDINGS silently stopped regenerating.
 *  - `prints.push(...day)` in the tick spread worker, three weeks later, by the
 *    same hand that fixed the first one and wrote it up in the journal. A day
 *    of aggTrades on a liquid contract is 666,782 prints.
 *
 * A comment saying "do not do this" did not prevent the second. A failing check
 * is the only thing that reliably does, so new occurrences have to be declared
 * here — which forces the question "is this array bounded?" to be answered out
 * loud rather than assumed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/user/oddz";

/**
 * Occurrences that are bounded and therefore safe, each with the bound.
 *
 * Adding a line here is a claim that the array cannot grow past the argument
 * limit, and the reason has to be stated. Anything not listed fails.
 */
const ALLOWED: { file: string; why: string }[] = [
  { file: "lib/sweep/metrics/clusters.ts", why: "a week or month of 1m klines — tens of thousands at most, fixed by the window" },
  { file: "workers/sweep-control.ts", why: "one entry per desk; the desk list is a handful of configured symbols" },
  { file: "lib/sweep/agent/signals.ts", why: "each detector returns a few signals per tick, bounded by the detector not the data" },
  { file: "lib/sweep/binance/rest.ts", why: "routes is ['direct'] or ['direct','proxy'] — at most two" },
  { file: "lib/sweep/metrics/participants.ts", why: "priceSteps is [magnitude, magnitude/2] filtered — at most two" },
  { file: "lib/sweep/agent/evidence.ts", why: "the horizon keys of one row's outcomes — five, set by HORIZONS" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const offenders: string[] = [];
for (const file of [...walk(join(ROOT, "workers")), ...walk(join(ROOT, "lib"))]) {
  const rel = file.slice(ROOT.length + 1);
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    // A spread as the sole/leading argument of a call: f(...xs) or f(...xs.map(…)).
    if (!/[A-Za-z_$\])]\s*\(\s*\.\.\./.test(line)) return;
    // Comments are not calls.
    if (/^\s*(\*|\/\/)/.test(line)) return;
    /*
     * A rest parameter is a declaration, not a spread. `function cn(...inputs:
     * ClassValue[])` collects arguments into an array and has no limit problem
     * — the limit applies to the caller, and this check is looking for callers.
     */
    if (/\b(function|=>|constructor)\s*[A-Za-z_$]*\s*\(\s*\.\.\./.test(line)) return;
    if (/\(\s*\.\.\.[A-Za-z_$]+\s*:/.test(line)) return;
    if (ALLOWED.some((a) => a.file === rel)) return;
    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length) {
  console.error("  FAIL — array spread into a call, outside the allowlist:\n");
  for (const o of offenders) console.error(`    ${o}`);
  console.error(
    "\n  If the array is bounded, add the file to ALLOWED in this check with the bound.\n" +
      "  If it is not, use a loop — `for (const x of xs) out.push(x)` — or minOf/maxOf\n" +
      "  from lib/sweep/numeric. This has shipped twice; both times it was believed safe.",
  );
  process.exit(1);
}

console.log(`  ok — no unbounded array spreads (${ALLOWED.length} bounded site(s) declared)`);
console.log("\nall good — spread args");
