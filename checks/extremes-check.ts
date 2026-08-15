/**
 * The weekend's root cause: an extreme that price is already sitting on.
 *
 * When price makes new highs the session high IS the current price, so an
 * extreme emitted there describes a level whose stops have already fired. Over
 * 2000 real samples the nearest cluster above was closer than the one below in
 * 1985 of them — median 0.050% up against 0.318% down — which drove the bias's
 * heaviest factor permanently long: 1980 "up" calls out of 2000.
 */
import { extremeLevels } from "@/lib/sweep/metrics/clusters";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const k = (h: number, l: number, c: number) =>
  ({ t: Date.now() - 86400000, open: c, high: h, low: l, close: c, volume: 1 }) as never;
const daily = [k(100, 90, 99), k(102, 98, 101.9)];
const minutes: never[] = [];

console.log("\n## a level price is sitting on is not a pool of stops");
{
  const atHigh = extremeLevels(daily, minutes, 101.95);
  const inside = atHigh.filter((x) => Math.abs(x.price - 101.95) / 101.95 < 0.0005);
  ok("nothing is emitted inside the stop buffer of price", inside.length === 0,
    inside.map((x) => `${x.source}@${x.price.toFixed(3)}`).join(", ") || "clean");
  ok("...and real levels further out survive", atHigh.length > 0, `${atHigh.length} levels`);

  // The asymmetry that actually did the damage.
  const above = atHigh.filter((x) => x.price > 101.95).map((x) => (x.price - 101.95) / 101.95 * 100);
  const below = atHigh.filter((x) => x.price < 101.95).map((x) => (101.95 - x.price) / 101.95 * 100);
  const near = (a: number[]) => (a.length ? Math.min(...a) : Infinity);
  ok("the upside is no longer trivially the closest side",
    !(near(above) < 0.05 && near(below) > 0.2),
    `nearest up ${near(above).toFixed(3)}% / down ${near(below).toFixed(3)}%`);
}

console.log("\n## once price pulls back, the level is real again");
{
  // Pulled back to 99.5, well under the prior high of 100 — the stops above it
  // are untouched again, so the level is a genuine cluster.
  const back = extremeLevels(daily, minutes, 99.5);
  ok("the high above becomes a cluster once more",
    back.some((x) => x.price > 99.5), `${back.filter((x) => x.price > 99.5).length} above`);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
