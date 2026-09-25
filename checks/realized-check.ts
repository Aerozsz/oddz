/**
 * Realised impact is about to be laid beside the modelled curve and used to
 * decide whether the sizing table is optimistic. So the burst reconstruction
 * has to be right about the things that would quietly bias it:
 *
 *  - measuring from the burst's own first print, which has already crossed the
 *    spread, and so charging every small order one spread too little
 *  - getting the sign backwards on sells, which would report the seller's cost
 *    as a gain and halve the curve
 *  - gluing two unrelated orders into one burst across a gap
 *  - reporting a median over a handful of bursts as if it could argue with a
 *    modelled curve
 *  - reporting a temporary impact of zero, which is a cost bar everything clears
 */

import { bursts, curve } from "/home/user/oddz/workers/sweep-realized";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

type P = { t: number; price: number; qty: number; buyerIsMaker: boolean };
const p = (t: number, price: number, qty: number, buyerIsMaker: boolean): P => ({ t, price, qty, buyerIsMaker });

function aSweepIsOneOrder() {
  console.log("\na sweep is one burst, measured from before it");
  /*
   * A buyer lifting four levels: 100.00 rests, then prints at 100.01 through
   * 100.04, ten milliseconds apart. The move is 4bp from the pre-burst price,
   * and measuring from the burst's own first print would call it 3bp — the
   * missing basis point is the spread, which is exactly the part a small order
   * mostly pays.
   */
  const bs = bursts([
    p(0, 100.0, 1, true),
    p(100, 100.01, 10, false),
    p(110, 100.02, 10, false),
    p(120, 100.03, 10, false),
    p(130, 100.04, 10, false),
  ]);
  ok("one burst", bs.length === 1, String(bs.length));
  ok("four prints in it", bs[0]?.prints === 4, String(bs[0]?.prints));
  ok("the aggressor is the buyer", bs[0]?.buy === true);
  ok("measured from the price before it", Math.abs((bs[0]?.moveBps ?? 0) - 4) < 0.01, String(bs[0]?.moveBps));
  ok("notional is the sum", Math.abs((bs[0]?.usd ?? 0) - 4000.6) < 1, String(bs[0]?.usd));
}

function aSellCostsTheSeller() {
  console.log("\na sell burst reports a cost, not a gain");
  /*
   * The sign is the easiest thing to get wrong here and the most expensive: a
   * seller pushing price down is paying, and reporting that as a negative
   * impact would halve the curve by averaging the two sides against each other.
   */
  const bs = bursts([
    p(0, 100.0, 1, false),
    p(100, 99.99, 10, true),
    p(110, 99.98, 10, true),
  ]);
  ok("one burst", bs.length === 1);
  ok("the aggressor is the seller", bs[0]?.buy === false);
  ok("and it cost, positive", (bs[0]?.moveBps ?? -1) > 0, String(bs[0]?.moveBps));
  ok("by the distance travelled", Math.abs((bs[0]?.moveBps ?? 0) - 2) < 0.01, String(bs[0]?.moveBps));
}

function aGapSplitsTheBurst() {
  console.log("\na gap splits one burst into two orders");
  const bs = bursts([
    p(0, 100.0, 1, true),
    p(100, 100.01, 10, false),
    p(110, 100.02, 10, false),
    // A full second later: a different order, and gluing them together would
    // attribute a whole second of market movement to one sweep.
    p(1_200, 100.05, 10, false),
    p(1_210, 100.06, 10, false),
  ]);
  ok("two bursts", bs.length === 2, String(bs.length));
  ok("the first is measured from its own reference", Math.abs((bs[0]?.moveBps ?? 0) - 2) < 0.01, String(bs[0]?.moveBps));
  ok("and the second from the print before it", Math.abs((bs[1]?.moveBps ?? 0) - 4) < 0.02, String(bs[1]?.moveBps));
}

function aPushThatRevertsIsTemporary() {
  console.log("\na push that comes back is a cost; news is not");
  const tape: P[] = [p(0, 100.0, 1, true)];
  /*
   * Two hundred identical $10,000 sweeps, each moving price 5bp and each fully
   * reverting within the minute. The temporary component is the whole move,
   * which is what a round trip pays; a curve that reported zero here would
   * clear every finding in the project.
   */
  let t = 100;
  for (let i = 0; i < 200; i++) {
    tape.push(p(t, 100.0, 50, false));
    tape.push(p(t + 10, 100.05, 50, false));
    // Back to the reference, well past the settle horizon.
    tape.push(p(t + 61_000, 100.0, 1, true));
    t += 120_000;
  }
  const rows = curve(bursts(tape));
  const ten = rows.find((r) => r.usd === 10_000)!;
  ok("the band filled", ten.bursts >= 100, String(ten.bursts));
  ok("the move is measured", ten.moveBps !== null && ten.moveBps > 0, String(ten.moveBps));
  ok("it reverted", (ten.settleBps ?? 1) <= 0.01, String(ten.settleBps));
  ok(
    "so the temporary part is the whole move",
    ten.temporaryBps !== null && Math.abs(ten.temporaryBps - (ten.moveBps as number)) < 0.01,
    String(ten.temporaryBps),
  );
  ok("and it is never negative", rows.every((r) => r.temporaryBps === null || r.temporaryBps >= 0));
}

function aThinBandRefusesToAnswer() {
  console.log("\na band with too few bursts says nothing");
  const tape: P[] = [p(0, 100.0, 1, true)];
  let t = 100;
  for (let i = 0; i < 12; i++) {
    tape.push(p(t, 100.0, 50, false));
    tape.push(p(t + 10, 100.05, 50, false));
    t += 120_000;
  }
  const rows = curve(bursts(tape));
  const ten = rows.find((r) => r.usd === 10_000)!;
  ok("the band counted its bursts", ten.bursts > 0 && ten.bursts < 100, String(ten.bursts));
  ok("but reports no median", ten.moveBps === null, String(ten.moveBps));
  ok("and no temporary component", ten.temporaryBps === null);
}

console.log("realised impact");
aSweepIsOneOrder();
aSellCostsTheSeller();
aGapSplitsTheBurst();
aPushThatRevertsIsTemporary();
aThinBandRefusesToAnswer();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — realised impact");
