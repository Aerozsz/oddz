/**
 * Two statistics that tell a graded effect from an episode.
 *
 * `sigma` compares the top decile against the bottom and is blind to the eight
 * between them. On 2026-10-16 that blindness nearly cost a month: `mom30 @
 * t30d` showed a top decile of -26.89bp against a 7.63bp round trip, holding in
 * both halves, and the profile behind it ran 6.9, 1.2, -5.9, -2.9, 0.7, 0.1,
 * 5.3, 6.8, -1.4, -26.9 — nine buckets of noise and one cliff. A feature the
 * market responds to continuously does not do that, and `depth-inverted` was
 * rejected for exactly this shape after a 9.2bp spread turned out to live
 * entirely in its widest bucket.
 *
 * So the profile gets a number, and so does the question the carry work already
 * learned to ask: how much of a bucket is one day. Both are asserted here
 * against data whose answer is known by construction, because a diagnostic that
 * is itself wrong is worse than no diagnostic — it launders the thing it was
 * added to catch.
 */

import { scoreFeature, edge, monotone, type Sample, type Score } from "/home/user/oddz/lib/sweep/backtest/features";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

const DAY = 86_400_000;

/**
 * `n` samples whose feature value is the row index and whose return is
 * whatever `ret` says, spread over `days` calendar days.
 */
const samples = (n: number, ret: (i: number) => number, days = 30): Sample[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: Date.UTC(2026, 8, 1) + Math.floor((i / n) * days) * DAY + (i % 1440) * 60_000,
    features: { f: i },
    ret: { t30: ret(i) },
    mfe: { t30: Math.max(0, ret(i)) },
    mae: { t30: Math.min(0, ret(i)) },
  }));

function aGradientReadsAsGraded() {
  console.log("\na graded response reads as graded");
  /*
   * Return falls linearly with the feature, so every decile steps the same
   * way. This is the shape a real continuous effect makes and it must score
   * near -1; anything less would mean the statistic cannot recognise the thing
   * it exists to reward.
   */
  const s = scoreFeature(samples(4000, (i) => 10 - i / 200), "f", "t30");
  ok("ten buckets", s.length === 10, String(s.length));
  const m = monotone(s);
  ok("a clean gradient scores near -1", m < -0.97, m.toFixed(3));
  ok("and edge() carries it", Math.abs((edge(s).monotone ?? 0) - m) < 1e-12);
}

function oneCliffDoesNot() {
  console.log("\nnine flat buckets and a cliff do not");
  /*
   * The real profile that prompted this: noise everywhere, one extreme bucket.
   * `sigma` is large because the top bucket is far from the bottom; the
   * gradient is absent. The point of the assertion is that the two statistics
   * disagree, because that disagreement is the whole signal.
   */
  const noise = [0.9, -0.4, 0.7, -0.6, 0.2, -0.3, 0.5, -0.8, 0.1];
  const s = scoreFeature(
    samples(4000, (i) => (i >= 3600 ? -27 : noise[Math.floor(i / 400)])),
    "f",
    "t30",
  );
  const e = edge(s);
  ok("the spread is still large", Math.abs(e.spreadBps) > 20, e.spreadBps.toFixed(2));
  ok("and sigma is still large", Math.abs(e.sigma) > 5, e.sigma.toFixed(2));
  ok("but the profile is not graded", Math.abs(e.monotone) < 0.75, e.monotone.toFixed(3));
  /*
   * The comparison that matters, stated as one assertion: the cliff must look
   * materially less graded than the gradient, on spreads of the same size.
   */
  const graded = scoreFeature(samples(4000, (i) => 10 - i / 200), "f", "t30");
  ok(
    "and markedly less graded than a true gradient",
    Math.abs(e.monotone) < Math.abs(edge(graded).monotone) - 0.2,
    `${e.monotone.toFixed(3)} vs ${edge(graded).monotone.toFixed(3)}`,
  );
}

function oneDayIsVisible() {
  console.log("\na bucket that is one day says so");
  /*
   * Every row flat except a single day's worth inside the top bucket, which
   * carries the whole of it. The share must read near 1: that is an episode
   * wearing a decile mean, and it is what the carry table was corrected for.
   */
  const n = 4000;
  const rows = samples(n, (i) => (i >= 3700 && i < 3800 ? -100 : 0), 30);
  /* Force those hundred rows onto one calendar day, and nothing else onto it. */
  for (let i = 0; i < n; i++) {
    rows[i].ts =
      i >= 3700 && i < 3800
        ? Date.UTC(2026, 8, 15) + (i - 3700) * 60_000
        : Date.UTC(2026, 9, 1) + i * 60_000;
  }
  const top = scoreFeature(rows, "f", "t30")[9] as Score;
  ok("the bucket is not one day of rows", (top.days ?? 0) > 1, String(top.days));
  ok("but one day is nearly all of its return", (top.topDayShare ?? 0) > 0.95,
    (top.topDayShare ?? NaN).toFixed(3));

  /*
   * The same mean spread evenly over thirty days must read diffuse, or the
   * statistic condemns everything and distinguishes nothing.
   */
  const even = scoreFeature(samples(4000, (i) => (i >= 3600 ? -25 : 0), 30), "f", "t30")[9] as Score;
  ok("an evenly spread bucket reads diffuse", (even.topDayShare ?? 1) < 0.5,
    `${(even.topDayShare ?? NaN).toFixed(3)} over ${even.days} days`);
}

function aDayAgainstTheBucketDoesNotInflate() {
  console.log("\na day pulling the other way lowers the share, not raises it");
  /*
   * Signed sums. With absolute values a day that contributed against the
   * bucket's direction would read as concentration, which inverts the meaning
   * of the column exactly when it matters: a bucket whose total is small
   * because two large days cancelled is the least trustworthy of all, and must
   * not be reported as diffuse by accident either.
   */
  const n = 4000;
  const rows = samples(n, () => 0, 30);
  for (let i = 0; i < n; i++) {
    rows[i].ret.t30 = i >= 3800 && i < 3900 ? -100 : i >= 3900 ? 50 : 0;
    rows[i].ts =
      i >= 3800 && i < 3900
        ? Date.UTC(2026, 8, 15) + (i - 3800) * 60_000
        : i >= 3900
          ? Date.UTC(2026, 8, 16) + (i - 3900) * 60_000
          : Date.UTC(2026, 9, 1) + i * 60_000;
  }
  const top = scoreFeature(rows, "f", "t30")[9] as Score;
  /* -10,000 and +5,000 against a total of -5,000: the share is 2, not 0.67. */
  ok("the share exceeds one when days cancel", (top.topDayShare ?? 0) > 1.5,
    (top.topDayShare ?? NaN).toFixed(2));
  ok("and its sign follows the bucket", (top.topDayShare ?? 0) > 0);
}

function aNearZeroBucketReportsNothing() {
  console.log("\na bucket with no total reports no share");
  /*
   * Dividing by a total that is nearly zero produces a number with no meaning
   * and a large magnitude, which is the most dangerous kind of output: it
   * would flag the emptiest buckets as the most concentrated.
   */
  const s = scoreFeature(samples(4000, () => 0), "f", "t30")[5] as Score;
  ok("the share is withheld", s.topDayShare === undefined, String(s.topDayShare));
  ok("the day count is still reported", (s.days ?? 0) > 1, String(s.days));
}

console.log("decile profile and concentration");
aGradientReadsAsGraded();
oneCliffDoesNot();
oneDayIsVisible();
aDayAgainstTheBucketDoesNotInflate();
aNearZeroBucketReportsNothing();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — decile profile and concentration");
