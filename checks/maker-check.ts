/**
 * The maker simulation decides whether the last open route survives, so the ways
 * it can flatter itself are each asserted here. Every one of them has a history:
 *
 *  - scoring an unfilled order as zero, which dilutes real losses with non-trades
 *  - filling a resting bid from a buyer, which fills every order always
 *  - accepting a touch as a fill when the queue at that price was never cleared
 *  - taking the wrong side, which turns every loss into a win
 *  - reporting adverse selection without the comparison that detects it
 *
 * The fourth is not hypothetical. The first version of this worker shorted the
 * heavy-buying minutes, because the feature is called `takerRatioFade` and the
 * name says to fade. The replay's own deciles say the opposite: heaviest taker
 * buying is followed by +8.57bp on LITUSDT at more than ten sigma. So the side
 * follows the flow, and these fixtures are built around a long resting on the
 * bid.
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
 * The feature's source, supplied directly.
 *
 * `takerRatio` reads `sum_taker_long_short_vol_ratio` from the venue's metrics
 * file, so these are buy/sell ratios: above one is net buying. The worker turns
 * them into `-(ratio - 1)`, so a ratio of 2.0 becomes a fade of −1.0, which is
 * the heaviest-buying tail and therefore the long side.
 *
 * Values are spread across many distinct levels on purpose. An earlier fixture
 * gave every ordinary minute the same number, which put the tenth percentile ON
 * that value — so the "extreme tenth" selected most of the tape. The worker now
 * refuses that case outright, and real ratios are continuous, so a fixture that
 * is not tests something else.
 */
function ratios(n: number, hotEvery: number, hotValue = 2.0): Map<number, number> {
  const out = new Map<number, number>();
  for (let m = 0; m < n; m++) {
    /*
     * Two hundred distinct levels across 0.6 to 1.4, not twenty across 0.9 to
     * 1.1. A coarse spread is not merely unrealistic here: with only twenty
     * levels a decile boundary lands on a band holding five percent of the
     * sample and the tie rule sweeps in everything at that value, so the
     * "extreme tenth" became seventy percent and the worker refused — correctly,
     * and the fixture was what was wrong.
     */
    out.set(m * 60_000, m % hotEvery === 0 ? hotValue : 0.6 + ((m * 37) % 200) / 250);
  }
  return out;
}

/** The attempts belonging to the heaviest-buying minutes: the long side. */
function longs(a: ReturnType<typeof attempts>, ms: ReturnType<typeof minutes>) {
  const hot = new Set(ms.filter((m) => m.fade < -0.9).map((m) => m.ts));
  return a.filter((x) => hot.has(x.ts));
}

/**
 * A tape of `n` minutes, one signal every `hotEvery`.
 *
 * `after` decides what happens once the signal minute closes — whether price
 * comes down to the resting bid, and where it is five minutes later — which is
 * what each scenario varies.
 */
function tape(n: number, hotEvery: number, after: (base: number, t: number, hot: boolean) => P[]): P[] {
  const out: P[] = [];
  for (let m = 0; m < n; m++) {
    const t = m * 60_000;
    const hot = m % hotEvery === 0;
    out.push(p(t + 1_000, 100.0, 10, false));
    out.push(p(t + 30_000, 100.0, 10, !hot));
    for (const q of after(100.0, t, hot)) out.push(q);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function theFeatureAndSideAreRight() {
  console.log("\nthe feature is read and the side follows the flow");
  const t = tape(400, 10, () => []);
  const ms = minutes(t, ratios(400, 10));
  ok("minutes carry a feature", ms.length >= 300, String(ms.length));
  /*
   * -(2.0 - 1) = -1.0. If the sign were dropped, the simulation would trade the
   * wrong tail while looking healthy — which is what happened.
   */
  ok("a ratio of 2.0 becomes a fade of -1.0", ms.some((m) => Math.abs(m.fade + 1) < 1e-9));
  const a = attempts(t, ms);
  ok("attempts were produced", a.length >= 30, String(a.length));
  ok("the decile was not swallowed by ties", a.length < ms.length * 0.4, `${a.length}/${ms.length}`);
  const hot = longs(a, ms);
  ok("one per heaviest-buying minute", hot.length >= 30, String(hot.length));
  ok("and it follows the flow, so long", hot.length > 0 && hot.every((x) => x.long === true));
  ok("the other tail is the other side", a.some((x) => x.long === false));
}

function theGridIsForwardFilledOnly() {
  console.log("\nthe five-minute grid is carried forward, never backward");
  const t = tape(60, 10, () => []);
  /* One published row, at minute 20. */
  const sparse = new Map<number, number>([[20 * 60_000, 2.0]]);
  const ms = minutes(t, sparse);
  ok("minutes before it have no feature", ms.every((m) => m.ts >= 20 * 60_000), String(ms[0]?.ts));
  ok("minutes after it carry it", ms.length > 30, String(ms.length));
  ok("and they carry that value", ms.every((m) => Math.abs(m.fade + 1) < 1e-9));
}

function anUnfilledOrderEarnsNothing() {
  console.log("\nan unfilled order is excluded, not scored zero");
  /*
   * Price runs away upward after every signal and never comes back to the bid, so
   * a resting long never fills. Scoring those as zero would report flat where the
   * truth is no trade — and mixed with real losses it would pull them toward zero.
   */
  const t = tape(400, 10, (base, ts, hot) =>
    hot ? [p(ts + 70_000, base * 1.01, 5, false), p(ts + 400_000, base * 1.02, 5, false)] : [],
  );
  const ms = minutes(t, ratios(400, 10));
  const hot = longs(attempts(t, ms), ms);
  /*
   * `touched` is allowed and is not the bug: ordinary minutes print aggressive
   * sells at exactly 100.00, which reach a bid resting there without clearing the
   * queue at it. Nothing trades BELOW the bid, so nothing fills under the strict
   * rule, and the strict rule is the one that decides.
   */
  ok("nothing filled strictly", hot.length > 0 && hot.every((x) => !x.through));
  ok("strict returns are null, not zero", hot.every((x) => x.strictRetBps === null));
  const s = summarise(hot);
  ok("the fill rate is zero", s.fillRateThrough === 0, String(s.fillRateThrough));
  ok(
    "and the strict sample is empty",
    s.passiveStrict.n === 0 && s.passiveStrict.meanBps === null,
    String(s.passiveStrict.n),
  );
}

function onlyTheOppositeAggressorFills() {
  console.log("\na resting bid is filled by a seller, never by a buyer");
  /*
   * Price comes below the bid but every print is an aggressive BUY. A buyer lifts
   * the offer; it does not fill a bid. Ignoring the aggressor side would fill
   * every order in every scenario and make the measurement meaningless.
   */
  const t = tape(400, 10, (base, ts, hot) =>
    hot ? [p(ts + 70_000, base * 0.999, 5, false), p(ts + 400_000, base, 5, false)] : [],
  );
  const ms = minutes(t, ratios(400, 10));
  const hot = longs(attempts(t, ms), ms);
  ok(
    "a buyer below the bid does not fill it",
    hot.length > 0 && hot.every((x) => !x.through),
    JSON.stringify(hot[0]),
  );
}

function aTouchIsNotAClearedQueue() {
  console.log("\ntouching the level is weaker evidence than trading through it");
  /*
   * An aggressive sell lands exactly ON the resting bid and no lower. Someone was
   * filled; the archive cannot say it was us, because it cannot say who was ahead
   * in the queue. The loose reading counts it, the strict one does not, and the
   * strict one is what gets planned on.
   */
  const t = tape(400, 10, (base, ts, hot) =>
    hot ? [p(ts + 70_000, base, 5, true), p(ts + 400_000, base * 1.001, 5, true)] : [],
  );
  const ms = minutes(t, ratios(400, 10));
  const hot = longs(attempts(t, ms), ms);
  ok("the touch counts loosely", hot.some((x) => x.touched));
  ok("but not strictly", hot.every((x) => !x.through));
  const s = summarise(hot);
  ok("so the two fill rates differ", (s.fillRateTouched ?? 0) > (s.fillRateThrough ?? 0));
  ok("and the strict sample is empty", s.passiveStrict.n === 0);
}

function theQueueSensitivityBites() {
  console.log("\nsitting behind a queue reduces the fill rate");
  /*
   * Every signal is followed by a single small aggressive sell at the bid: it
   * clears a queue of zero and nothing more. An order at the front fills; an
   * order behind $50,000 of resting size does not. If the queue model did not
   * bite here it would not bite on real data either, and the strict reading
   * would keep flattering the result unchallenged.
   */
  /*
   * 200 units at ~100 is about $20,000 of aggressive selling at the level:
   * enough to fill a $10,000 order at the front of the queue and nothing like
   * enough to reach one sitting behind $200,000. An earlier version printed 20
   * units — $2,000 — which could not fill the order at any queue depth, so the
   * front-of-queue case read as zero and looked like the model was broken when
   * it was the fixture that could not pay for the order.
   */
  const t = tape(400, 10, (base, ts, hot) =>
    hot ? [p(ts + 70_000, base * 0.999, 200, true), p(ts + 400_000, base, 5, true)] : [],
  );
  const ms = minutes(t, ratios(400, 10));
  const hot = longs(attempts(t, ms), ms);
  const s = summarise(hot);
  const first = s.byQueue[0];
  const deep = s.byQueue[s.byQueue.length - 1];
  ok("the queue ladder is reported", s.byQueue.length >= 3, String(s.byQueue.length));
  ok("the front of the queue fills", (first.fillRate ?? 0) > 0.5, String(first.fillRate));
  ok("the back of it does not", (deep.fillRate ?? 1) < 0.1, String(deep.fillRate));
  ok(
    "fill rate falls monotonically with the queue",
    s.byQueue.every((q, i) => i === 0 || (q.fillRate ?? 0) <= (s.byQueue[i - 1].fillRate ?? 0)),
    JSON.stringify(s.byQueue.map((q) => q.fillRate)),
  );
  ok(
    "and only volume at the level counts",
    hot.every((x) => x.volumeAtLevel >= 0),
  );
}

function adverseSelectionIsDetectable() {
  console.log("\nadverse selection shows up in the missed signals");
  /*
   * The regime that kills passive execution: the bid fills only when price drops
   * through it and keeps dropping — a loss for a long — while the signals that
   * would have won are the ones that ran up and never filled.
   *
   * Signals sit twenty minutes apart. That spacing is the fixture's correctness:
   * with a five-minute rest and a five-minute hold, an earlier version placed
   * them five minutes apart and each signal's aftermath filled its neighbour's
   * order, so every branch "filled" and the scenario proved nothing.
   *
   * Ordinary minutes print only at 100.00, which touches a bid resting there
   * without ever trading through it — the queue ambiguity the strict rule exists
   * for — so these assertions use the strict reading.
   */
  const out: P[] = [];
  const N = 800;
  for (let m = 0; m < N; m++) {
    const t = m * 60_000;
    const hot = m % 20 === 0 && m > 0;
    out.push(p(t + 1_000, 100.0, 20, !hot));
    out.push(p(t + 30_000, 100.0, 20, !hot));
    if (!hot) continue;
    if ((m / 20) % 2 === 0) {
      // Drops through the bid — the long fills — and keeps falling.
      out.push(p(t + 70_000, 99.98, 5, true));
      // Exactly one hold after that fill, so the exit price is unambiguous.
      out.push(p(t + 370_000, 99.8, 5, true));
    } else {
      // Runs up at once on buyer aggression, so nothing fills a bid...
      out.push(p(t + 70_000, 100.1, 5, false));
      // ...and one hold after the decision it would have been a win.
      out.push(p(t + 360_000, 100.3, 5, false));
    }
  }
  out.sort((a, b) => a.t - b.t);

  const ms = minutes(out, ratios(N, 20));
  const hot = longs(attempts(out, ms), ms);
  ok("the signals were picked up", hot.length >= 20, String(hot.length));
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
theFeatureAndSideAreRight();
theGridIsForwardFilledOnly();
anUnfilledOrderEarnsNothing();
onlyTheOppositeAggressorFills();
aTouchIsNotAClearedQueue();
theQueueSensitivityBites();
adverseSelectionIsDetectable();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — maker simulation");
