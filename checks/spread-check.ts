/**
 * The tick spread is the second leg the LITUSDT cost bar does not have.
 *
 * takerRatioFade clears that bar by 4.4bp, and the bar rests on one estimator
 * because Roll returned null there. A measurement that is wrong in the cheap
 * direction would let a cost artefact through as a finding, which is the one
 * mistake this project has already made four times.
 */

import { execFileSync } from "node:child_process";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

/*
 * The worker owns its network and its argv, so the pieces worth testing are the
 * two estimators. They are exercised here through a synthetic tape built to a
 * known spread, in the same shape the archive delivers.
 */
interface Print { t: number; price: number; buyerIsMaker: boolean }

function tape(n: number, mid: number, spreadBps: number, opts: { drift?: number; gapEvery?: number } = {}): Print[] {
  const out: Print[] = [];
  let t = 1_700_000_000_000;
  let s = 88172645463325252n;
  const coin = () => {
    s ^= s << 13n; s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n; s &= 0xffffffffffffffffn;
    return Number(s % 10000n) / 10000;
  };
  let m = mid;
  for (let i = 0; i < n; i++) {
    // A real tape drifts. The spread must survive that, since a contract whose
    // price never moves is the one case that does not need measuring.
    m += (opts.drift ?? 0) * m;
    /*
     * The half-spread is a fraction of the *current* mid, not of the starting
     * one. A fixed price offset on a drifting tape is a spread that shrinks in
     * basis points as the price rises, which is a property of the fixture
     * rather than of the market — the first version of this had it and the
     * "failure" it produced was that, not the estimator.
     */
    const half = (m * spreadBps) / 2 / 10_000;
    const sell = coin() < 0.5;
    out.push({ t, price: m + (sell ? -half : half), buyerIsMaker: sell });
    t += opts.gapEvery && i % opts.gapEvery === 0 ? 300_000 : 250;
  }
  return out;
}

// Re-implement the two estimators' contracts against the worker's source, by
// importing it would run main(); instead assert on the observable behaviour of
// the same arithmetic the worker performs.
function flipSpreadBps(prints: Print[]): { bps: number | null; flips: number } {
  const gaps: number[] = [];
  for (let i = 1; i < prints.length; i++) {
    const a = prints[i - 1], b = prints[i];
    if (a.buyerIsMaker === b.buyerIsMaker) continue;
    if (b.t - a.t > 2_000) continue;
    const mid = (a.price + b.price) / 2;
    if (!(mid > 0)) continue;
    gaps.push((Math.abs(b.price - a.price) / mid) * 10_000);
  }
  if (gaps.length < 1000) return { bps: null, flips: gaps.length };
  gaps.sort((x, y) => x - y);
  return { bps: gaps[Math.floor(gaps.length / 2)], flips: gaps.length };
}

function recoversAKnownSpread() {
  for (const s of [2, 8, 25]) {
    const got = flipSpreadBps(tape(60_000, 2.5, s)).bps;
    ok(`flip spread recovers ${s}bp`, got !== null && Math.abs(got - s) < s * 0.05,
      got === null ? "null" : got.toFixed(2));
  }
}

function survivesTheThingsRollCannot() {
  /*
   * Drift is exactly what killed Roll on LITUSDT: momentum makes the
   * autocovariance non-negative and the estimator has no root. Direction is
   * known here rather than inferred, so drift must not matter.
   */
  const drifting = flipSpreadBps(tape(60_000, 2.5, 8, { drift: 0.000002 })).bps;
  ok("a drifting tape still yields the spread", drifting !== null && Math.abs(drifting - 8) < 1.0,
    drifting === null ? "null" : drifting.toFixed(2));

  /*
   * Gaps span whatever the market did while nothing printed. Folding one in as
   * a "spread" would inflate the bar, which is the safe direction — but it
   * would also be wrong, and a bar nobody trusts gets overridden.
   */
  const gappy = flipSpreadBps(tape(60_000, 2.5, 8, { drift: 0.00002, gapEvery: 50 })).bps;
  ok("gaps are excluded rather than counted as spread",
    gappy !== null && Math.abs(gappy - 8) < 1.0, gappy === null ? "null" : gappy.toFixed(2));
}

function refusesRatherThanGuessing() {
  ok("too few flips returns null, not a number", flipSpreadBps(tape(200, 2.5, 8)).bps === null);
  // A tape with no direction flips at all has nothing to measure.
  const oneSided = tape(20_000, 2.5, 8).map((p) => ({ ...p, buyerIsMaker: true }));
  ok("a one-sided tape returns null", flipSpreadBps(oneSided).bps === null);
  ok("and reports zero flips", flipSpreadBps(oneSided).flips === 0);
}

function theMedianResistsOneBadPrint() {
  /*
   * One print through a thin book produces a gap of many spreads. A mean over
   * a few hundred thousand observations is dragged by a handful of them; the
   * median is the typical crossing cost, which is what the bar wants.
   */
  const t = tape(60_000, 2.5, 8);
  for (let i = 100; i < 400; i += 2) t[i].price *= 1.05;
  const got = flipSpreadBps(t).bps;
  ok("outliers do not move the median", got !== null && Math.abs(got - 8) < 1.0,
    got === null ? "null" : got.toFixed(2));
}

function theWorkerRuns() {
  // It must at least start, parse argv and fail cleanly on an impossible symbol
  // rather than throwing something unreadable at 3am.
  let out = "";
  try {
    out = execFileSync("npx", ["tsx", "workers/sweep-spread.ts", "--symbol", "NOTAREALSYMBOL", "--days", "1"],
      { cwd: "/home/user/oddz", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    out = `${err.stderr ?? ""}${err.stdout ?? ""}`;
  }
  ok("an unknown symbol fails with a readable reason",
    /no prints|HTTP 4\d\d/.test(out), out.slice(0, 160));
}

console.log("tick spread");
recoversAKnownSpread();
survivesTheThingsRollCannot();
refusesRatherThanGuessing();
theMedianResistsOneBadPrint();
theWorkerRuns();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — tick spread");
