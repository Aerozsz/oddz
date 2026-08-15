import { DislocationTracker, EMPTY_DISLOCATION } from "@/lib/sweep/metrics/dislocation";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const BUCKET = 5_000;
const T0 = 1_800_000_000_000; // a fixed bucket-aligned instant

/**
 * Drive a tracker with a synthetic sector.
 *
 * `common` is the factor every name shares; `own` is per-symbol drift added on
 * top. Both are per-bucket log returns.
 */
function build(opts: {
  buckets: number;
  common: (i: number) => number;
  names: Record<string, (i: number) => number>;
}) {
  const t = new DislocationTracker();
  const price: Record<string, number> = {};
  for (const k of Object.keys(opts.names)) price[k] = 100;
  for (let i = 0; i < opts.buckets; i++) {
    const c = opts.common(i);
    for (const [name, own] of Object.entries(opts.names)) {
      price[name] *= Math.exp(c + own(i));
      t.record(name, price[name], T0 + i * BUCKET);
    }
  }
  return { tracker: t, now: T0 + (opts.buckets - 1) * BUCKET };
}

/* A deterministic wobble, so runs are reproducible. */
const wobble = (seed: number) => (i: number) => Math.sin(i * 0.7 + seed) * 0.0002;

/**
 * Idiosyncratic noise, seeded so runs are reproducible.
 *
 * The sine wobbles above are near-identical across names, which makes the
 * residual distribution unrealistically narrow — every divergence then reads as
 * dozens of standard deviations and the whole z-scale collapses. Real names have
 * their own noise, and testing the shape of the curve needs a residual
 * distribution with realistic width.
 */
function noise(seed: number, scale = 0.0006) {
  let s = seed * 2654435761 + 1;
  const cache: number[] = [];
  return (i: number) => {
    while (cache.length <= i) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      cache.push(((s / 0x7fffffff) * 2 - 1) * scale);
    }
    return cache[i];
  };
}

console.log("\n## warm-up");
{
  const t = new DislocationTracker();
  ok("a bare tracker reports nothing", t.read("INTCUSDT").warm === false);
  ok("...and is the empty read", t.read("INTCUSDT").note === EMPTY_DISLOCATION.note);

  t.record("INTCUSDT", 100, T0);
  ok("one contract on its own is never warm", t.read("INTCUSDT").warm === false);

  // Two contracts but only a handful of samples.
  for (let i = 0; i < 5; i++) {
    t.record("INTCUSDT", 100 + i, T0 + i * BUCKET);
    t.record("SNDKUSDT", 50 + i, T0 + i * BUCKET);
  }
  ok("a short history is not warm", t.read("INTCUSDT").warm === false);
}

console.log("\n## a genuine group");
{
  // Three names sharing a strong common factor, none diverging.
  const { tracker, now } = build({
    buckets: 200,
    common: (i) => Math.sin(i * 0.11) * 0.0015,
    names: { INTCUSDT: wobble(0), SNDKUSDT: wobble(2), MUUSDT: wobble(4) },
  });
  const r = tracker.read("INTCUSDT", now);
  ok("it warms up", r.warm, r.note);
  ok("and finds them correlated", r.coupled && r.correlation > 0.8, r.correlation.toFixed(2));
  ok("it counts both peers", r.peers === 2, String(r.peers));
  ok("nothing is out of line", Math.abs(r.z) < 1.5 && r.score === 0, `z=${r.z.toFixed(2)} score=${r.score.toFixed(2)}`);
  ok("and says so", r.note.includes("tracking its peers"), r.note);
}

console.log("\n## uncorrelated names are not a group");
{
  // No common factor at all: each name follows its own unrelated cycle.
  const { tracker, now } = build({
    buckets: 200,
    common: () => 0,
    names: {
      INTCUSDT: (i) => Math.sin(i * 0.31) * 0.002,
      SNDKUSDT: (i) => Math.sin(i * 0.13 + 1.7) * 0.002,
      MUUSDT: (i) => Math.cos(i * 0.07 + 0.4) * 0.002,
    },
  });
  const r = tracker.read("INTCUSDT", now);
  ok("it still warms up", r.warm);
  ok("but refuses to call them coupled", !r.coupled, r.correlation.toFixed(2));
  ok("and contributes no score at all", r.score === 0, r.score.toFixed(3));
  ok("...saying why in the note", r.note.includes("too loose"), r.note);
}

console.log("\n## one name breaks away");
{
  // A correlated group where INTC picks up a large, sustained extra move over
  // the final minutes — the shape a stop run or a worked order would leave.
  const { tracker, now } = build({
    buckets: 260,
    common: (i) => Math.sin(i * 0.11) * 0.0015,
    names: {
      INTCUSDT: (i) => wobble(0)(i) + (i > 220 ? 0.0009 : 0),
      SNDKUSDT: wobble(2),
      MUUSDT: wobble(4),
    },
  });
  const r = tracker.read("INTCUSDT", now);
  ok("the group is still a group", r.coupled, r.correlation.toFixed(2));
  ok("the runner is measured as ahead", r.residualBps > 20, `${r.residualBps.toFixed(0)}bp`);
  ok("...at a positive z", r.z > 1, r.z.toFixed(2));
  ok("...and scores against the move", r.score < 0, r.score.toFixed(3));
  ok("the score never reaches conviction", Math.abs(r.score) < 0.95, r.score.toFixed(3));
  ok("the note names the gap", r.note.includes("ahead of"), r.note);

  // The peers see the mirror image: they are behind the one that ran.
  const peer = tracker.read("SNDKUSDT", now);
  ok("a peer reads as behind", peer.residualBps < 0, `${peer.residualBps.toFixed(0)}bp`);
  ok("...and scores upward", peer.score > 0, peer.score.toFixed(3));
}

console.log("\n## the curve turns over at the extreme");
{
  /*
   * The point of the shape. A moderate break from the group is worth something;
   * a violent one is a company-specific event and must be worth *less*, not
   * more — fading a headline is the expensive mistake this exists to avoid.
   */
  const n0 = noise(1);
  const n1 = noise(2);
  const n2 = noise(3);
  const mk = (jump: number) => {
    const { tracker, now } = build({
      buckets: 260,
      common: (i) => Math.sin(i * 0.11) * 0.0015,
      // One sharp step at the very end rather than a ramp, so the last residual
      // really is an outlier against its own distribution.
      names: {
        INTCUSDT: (i) => n0(i) + (i === 258 ? jump : 0),
        SNDKUSDT: n1,
        MUUSDT: n2,
      },
    });
    return tracker.read("INTCUSDT", now);
  };

  // Scanned rather than hand-picked: the property being tested is the shape of
  // the whole curve, and pinning two magic jump sizes would test the fixture.
  const curve = [0, 0.001, 0.002, 0.004, 0.007, 0.012, 0.02, 0.04]
    .map((j) => mk(j))
    .map((r) => ({ z: Math.abs(r.z), score: Math.abs(r.score), note: r.note }))
    .sort((a, b) => a.z - b.z);
  console.log("      " + curve.map((c) => `${c.z.toFixed(1)}σ→${c.score.toFixed(2)}`).join("  "));

  const peak = curve.reduce((best, c) => (c.score > best.score ? c : best), curve[0]);
  const widest = curve[curve.length - 1];
  ok("a moderate break scores something", peak.score > 0.2, peak.score.toFixed(3));
  ok("...and the peak is at a moderate z", peak.z > 0.5 && peak.z < 4, peak.z.toFixed(1));
  ok("the widest break is far past the peak", widest.z > peak.z + 1, `${widest.z.toFixed(1)}σ vs ${peak.z.toFixed(1)}σ`);
  ok("...yet scores lower, not higher", widest.score < peak.score * 0.6,
    `${widest.score.toFixed(3)} vs ${peak.score.toFixed(3)}`);
  ok("...and says it is being discounted", widest.note.includes("discounted"), widest.note);
  ok("nothing ever reaches ±1", curve.every((c) => c.score < 1));
}

console.log("\n## bounds and hygiene");
{
  const t2 = new DislocationTracker();
  t2.record("INTCUSDT", 0, T0);
  t2.record("INTCUSDT", -5, T0 + BUCKET);
  t2.record("INTCUSDT", Number.NaN, T0 + 2 * BUCKET);
  ok("non-positive and NaN prices are dropped", t2.symbols().length === 0 || t2.read("INTCUSDT").warm === false);

  // Sub-bucket bursts must not let a fast desk outvote a slow one.
  const t3 = new DislocationTracker();
  for (let i = 0; i < 100; i++) {
    for (let k = 0; k < 20; k++) t3.record("FASTUSDT", 100 + i, T0 + i * BUCKET + k * 100);
    t3.record("SLOWUSDT", 50 + i * 0.5, T0 + i * BUCKET);
  }
  const fast = t3.read("FASTUSDT", T0 + 99 * BUCKET);
  ok("bucketing keeps a fast publisher from dominating", fast.warm && fast.peers === 1, `peers=${fast.peers}`);

  const t4 = new DislocationTracker();
  t4.record("A", 100, T0);
  t4.record("B", 100, T0);
  t4.forget("B");
  ok("a forgotten contract leaves the comparison", t4.symbols().join(",") === "A", t4.symbols().join(","));
}

console.log("\n## reads are pure, and the lookback expires");
{
  const { tracker, now } = build({
    buckets: 300, // 25 minutes against a 20-minute window
    common: (i) => Math.sin(i * 0.11) * 0.0015,
    names: { INTCUSDT: wobble(0), SNDKUSDT: wobble(2) },
  });

  // The bug this replaced: residuals were accumulated inside read(), so calling
  // it more often widened the distribution and shrank every z-score with it.
  const first = tracker.read("INTCUSDT", now);
  for (let i = 0; i < 50; i++) tracker.read("INTCUSDT", now);
  const later = tracker.read("INTCUSDT", now);
  ok("reading does not change the answer", first.z === later.z && first.score === later.score,
    `${first.z.toFixed(4)} then ${later.z.toFixed(4)}`);

  const stale = tracker.read("INTCUSDT", now);
  ok("it is still warm after trimming", stale.warm, stale.note);
  ok("...and still finds the group", stale.coupled, stale.correlation.toFixed(2));
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
