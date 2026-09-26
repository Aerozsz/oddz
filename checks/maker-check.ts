/**
 * The maker simulation is about to decide whether the last open route survives,
 * so the ways it could flatter itself are the ways this project has already been
 * wrong once each:
 *
 *  - scoring an unfilled order as zero, which dilutes losses with non-trades
 *  - filling a resting bid from a buyer, which fills every order always
 *  - accepting a touch as a fill when the queue at that price was never cleared
 *  - getting the fade direction backwards, so a loss reads as a win
 *  - reporting adverse selection without the comparison that detects it
 */

import { minutes, attempts, summarise } from "/home/user/oddz/workers/sweep-maker";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

type P = { t: number; price: number; qty: number; buyerIsMaker: boolean };
const p = (t: number, price: number, qty: number, buyerIsMaker: boolean): P => ({ t, price, qty, buyerIsMaker });

/**
 * An ordinary minute, with a taker ratio spread across many distinct values.
 *
 * An earlier fixture gave every ordinary minute exactly 0.5, which put the tenth
 * percentile ON that value — so the "extreme decile" selected 90% of the tape.
 * The worker now refuses that case outright and the fixture no longer produces
 * it: real taker ratios are continuous, and a fixture that is not tests
 * something else.
 */
function ordinary(t: number, m: number): P[] {
  const out: P[] = [];
  const buys = 3 + ((m * 7) % 25);
  for (let k = 0; k < buys; k++) out.push(p(t + 1_000 + k, 100.0, 1, false));
  for (let k = 0; k < 30 - buys; k++) out.push(p(t + 1_100 + k, 100.0, 1, true));
  return out;
}

/**
 * The attempts belonging to the fully-bought minutes.
 *
 * The decile split picks BOTH tails by design, so a tape whose only constructed
 * regime is heavy buying still produces long attempts from its thinnest-bought
 * ordinary minutes. Those are not what these scenarios are about, and asserting
 * over all attempts confuses the two.
 */
function shorts(a: ReturnType<typeof attempts>, ms: ReturnType<typeof minutes>) {
  const hot = new Set(ms.filter((m) => m.ratio > 0.99).map((m) => m.ts));
  return a.filter((x) => hot.has(x.ts));
}

/**
 * A tape of `n` minutes where every tenth is overwhelmingly taker-bought.
 *
 * `after` decides what happens once the extreme minute closes, which is what
 * each scenario varies: whether price comes back to the resting offer, and where
 * it ends up five minutes later.
 */
function tape(n: number, after: (base: number, t: number, extreme: boolean) => P[]): P[] {
  const out: P[] = [];
  for (let m = 0; m < n; m++) {
    const t = m * 60_000;
    const extreme = m % 10 === 0;
    if (extreme) {
      // Lopsided buying: taker buys only, so the ratio is 1.
      out.push(p(t + 1_000, 100.0, 10, false));
      out.push(p(t + 2_000, 100.0, 10, false));
      out.push(p(t + 30_000, 100.0, 10, false));
    } else {
      /*
       * Varied, not a single tied value. An earlier version of this fixture gave
       * every ordinary minute a ratio of exactly 0.5, which put the tenth
       * percentile ON that value — so the "extreme decile" selected 90% of the
       * tape and labelled it long. The worker now refuses that case outright,
       * and the fixture no longer produces it, because real taker ratios are
       * continuous and a fixture that is not tests the wrong thing.
       */
      for (const q of ordinary(t, m)) out.push(q);
    }
    for (const q of after(100.0, t, extreme)) out.push(q);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function theRatioAndDecileWork() {
  console.log("\nextreme-flow minutes are found");
  const t = tape(400, () => []);
  const ms = minutes(t);
  ok("minutes are built", ms.length >= 300, String(ms.length));
  ok("one in ten reads fully bought", ms.filter((m) => m.ratio > 0.99).length >= 30);
  const a = attempts(t, ms);
  ok("attempts were produced", a.length >= 30, String(a.length));
  ok("the decile was not swallowed by ties", a.length < ms.length * 0.4, `${a.length}/${ms.length}`);
  const hot = shorts(a, ms);
  ok("one per fully-bought minute", hot.length >= 30, String(hot.length));
  /*
   * Heavy taker buying fades DOWN, so the position is short. Getting this
   * backwards would turn every loss into a win and is the single most
   * expensive sign error available here.
   */
  ok("and it fades the flow, so short", hot.length > 0 && hot.every((x) => x.long === false));
  ok("the other tail is the other side", a.some((x) => x.long === true));
}

function anUnfilledOrderEarnsNothing() {
  console.log("\nan unfilled order is excluded, not scored zero");
  /*
   * Price runs away upward after every extreme minute and never returns to the
   * offer, so a resting short never fills. Scoring those as zero would report a
   * flat result where the truth is no trade at all — and with real losses mixed
   * in, it would dilute them toward zero.
   */
  const t = tape(400, (base, ts, extreme) =>
    extreme
      ? [p(ts + 40_000, base * 1.01, 5, false), p(ts + 400_000, base * 1.02, 5, false)]
      : [],
  );
  const ms = minutes(t);
  const hot = shorts(attempts(t, ms), ms);
  ok("nothing filled", hot.length > 0 && hot.every((x) => !x.touched && !x.through));
  ok("returns are null, not zero", hot.every((x) => x.retBps === null && x.strictRetBps === null));
  const s = summarise(hot);
  ok("the fill rate is zero", s.fillRateThrough === 0, String(s.fillRateThrough));
  ok("and the passive sample is empty", s.passive.n === 0 && s.passive.meanBps === null);
}

function onlyTheOppositeAggressorFills() {
  console.log("\na resting offer is filled by a buyer, never by a seller");
  /*
   * Price returns to the level but every print is an aggressive SELL. A resting
   * offer sits above the market; a seller hitting the bid does not touch it.
   * Filling on this would fill every order in every scenario and make the whole
   * measurement meaningless.
   */
  /*
   * Outside the signal minute, deliberately. An earlier version put these at
   * +40s, inside it, which dragged the minute's own taker ratio down to 0.86 and
   * dropped it out of the extreme decile — so the scenario passed by testing
   * nothing.
   */
  const t = tape(400, (base, ts, extreme) =>
    extreme ? [p(ts + 70_000, base * 1.001, 5, true), p(ts + 400_000, base, 5, true)] : [],
  );
  const ms = minutes(t);
  const hot = shorts(attempts(t, ms), ms);
  /*
   * The sell prints at 100.10, above a short resting at 100.00. If the aggressor
   * side were ignored, every one of these would fill — a seller trading above
   * the offer is impossible in a real book and is the shape of the bug.
   *
   * `touched` is allowed to be true and that is not the bug: ordinary minutes
   * print aggressive buys at exactly 100.00, which legitimately reach the offer
   * without clearing the queue at it. That is the ambiguity the strict rule
   * exists to handle, and the strict rule is what this asserts.
   */
  ok(
    "a seller above the offer does not fill it",
    hot.length > 0 && hot.every((x) => !x.through),
    JSON.stringify(hot[0]),
  );
}

function aTouchIsNotAClearedQueue() {
  console.log("\ntouching the level is weaker evidence than trading through it");
  /*
   * An aggressive buy lands exactly ON the resting offer and no higher. Someone
   * was filled; the archive cannot say it was us, because it cannot say who was
   * ahead in the queue. So the loose reading counts it and the strict one does
   * not, and the strict one is what gets planned on.
   */
  const t = tape(400, (base, ts, extreme) =>
    extreme ? [p(ts + 40_000, base, 5, false), p(ts + 400_000, base * 0.999, 5, false)] : [],
  );
  const ms = minutes(t);
  const hot = shorts(attempts(t, ms), ms);
  ok("the touch counts loosely", hot.some((x) => x.touched));
  ok("but not strictly", hot.every((x) => !x.through));
  const s = summarise(hot);
  ok("so the two fill rates differ", (s.fillRateTouched ?? 0) > (s.fillRateThrough ?? 0));
  ok("and the strict sample is empty", s.passiveStrict.n === 0);
}

function adverseSelectionIsDetectable() {
  console.log("\nadverse selection shows up in the missed signals");
  /*
   * The regime that kills passive execution: the order fills only when price
   * runs against it, and the signals where it would have won are the ones it
   * never got.
   *
   * Signals sit twenty minutes apart. That spacing is the fixture's whole
   * correctness: with a five-minute rest and a five-minute hold, an earlier
   * version placed them five minutes apart and each signal's aftermath filled
   * the neighbouring signal's resting order. Every branch then "filled", which
   * is how a fixture reports that the worker cannot detect adverse selection
   * when what it cannot do is keep two scenarios apart.
   *
   * Ordinary minutes print only at 100.00. They touch a short resting at 100.00
   * without ever trading through it, which is exactly the queue ambiguity the
   * strict rule exists for — so these assertions use the strict reading.
   */
  const out: P[] = [];
  const signals: number[] = [];
  for (let m = 0; m < 800; m++) {
    const t = m * 60_000;
    if (m % 20 !== 0 || m === 0) {
      for (const q of ordinary(t, m)) out.push(q);
      continue;
    }
    signals.push(t);
    // Lopsided buying: a short signal, resting at 100.00.
    out.push(p(t + 1_000, 100.0, 20, false));
    out.push(p(t + 30_000, 100.0, 20, false));
    if ((m / 20) % 2 === 0) {
      // Price comes back through the offer — the short fills — and then rises.
      out.push(p(t + 70_000, 100.02, 5, false));
      // Exactly one hold after that fill, so the exit price is not ambiguous.
      out.push(p(t + 370_000, 100.2, 5, false));
    } else {
      // Falls away at once on seller aggression, so nothing fills a short...
      out.push(p(t + 70_000, 99.9, 5, true));
      // ...and one hold after the decision it would have been a win.
      out.push(p(t + 360_000, 99.7, 5, true));
    }
  }
  out.sort((a, b) => a.t - b.t);

  const ms = minutes(out);
  const hot = shorts(attempts(out, ms), ms);
  ok("the signals were picked up", hot.length >= 30, String(hot.length));
  const s = summarise(hot);
  ok(
    "some filled and some did not",
    (s.fillRateThrough ?? 0) > 0.2 && (s.fillRateThrough ?? 1) < 0.8,
    String(s.fillRateThrough),
  );
  ok("the fills lost", (s.passiveStrict.meanBps ?? 0) < 0, String(s.passiveStrict.meanBps));
  ok(
    "and crossing won on exactly the ones missed",
    (s.takerOnMissed.meanBps ?? 0) > 0,
    String(s.takerOnMissed.meanBps),
  );
  ok(
    "which is the mechanism, stated as a gap",
    (s.takerOnMissed.meanBps ?? 0) > (s.passiveStrict.meanBps ?? 0),
  );
}

console.log("maker simulation");
theRatioAndDecileWork();
anUnfilledOrderEarnsNothing();
onlyTheOppositeAggressorFills();
aTouchIsNotAClearedQueue();
adverseSelectionIsDetectable();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — maker simulation");
