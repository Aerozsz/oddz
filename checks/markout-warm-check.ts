/**
 * Does mark-out ever warm?
 *
 * It gates the maker entry path via canPostEntry, and the maker path took 0 of
 * 552 shadow trades. If this never warms, that is the whole explanation: every
 * entry crosses the spread and pays 3bp it did not have to.
 */
import { MarkoutTracker } from "../lib/sweep/metrics/markout";
import { canPostEntry } from "../lib/sweep/metrics/fees";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const m = new MarkoutTracker();
let t = 1_700_000_000_000;
let mid = 100_000;

// Two minutes of an ordinary tape: a print every 100ms, a book update every
// 50ms, price drifting on a random walk.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

for (let i = 0; i < 2400; i++) {          // 2400 × 50ms = 120s
  t += 50;
  mid += (rnd() - 0.5) * 20;
  if (i % 2 === 0) {
    const buyerIsMaker = rnd() > 0.5;
    const price = mid + (buyerIsMaker ? -5 : 5);
    m.onTrade({ t, price, qty: 0.02, notional: price * 0.02, buyerIsMaker }, t);
  }
  m.onMid(t, mid, 1.0);
}

const r = m.read(t);
console.log("\n## after two minutes of a normal tape");
console.log("   warm:", r.warm, " toxicity:", r.toxicity.toFixed(3), " informed:", r.informed.toFixed(3),
  " regime:", r.regime);
console.log("   horizons:", r.horizons.map(h => `${h.sec}s w=${h.weight.toFixed(1)}`).join("  "));

ok("mark-out warms on an ordinary tape", r.warm, `notes: ${r.notes.join(" | ")}`);
const post = canPostEntry(r);
ok("...so the maker path is at least reachable", post.ok || r.toxicity >= 0.6, post.reason);
console.log("   canPostEntry:", post.ok, "—", post.reason);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
