/**
 * A commit should mark a change, not the passage of time.
 *
 * The snapshot is rewritten every 30s with new timestamps, so "did it change"
 * was always yes and every pass produced a commit — ~700 a day, almost all of
 * them recording that nothing had happened.
 */
import { createHash } from "node:crypto";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const VOLATILE = /"(?:at|ts|uptimeSec|staleForMs|ageMs|lastPollAt|startedAt|snapshotAgeMs|msToNext|msSincePhaseStart|secondsSince|minutesSince)"\s*:\s*-?[\d.]+/g;
const h = (raw: string) => createHash("sha1").update(raw.replace(VOLATILE, "")).digest("hex");

const base = {
  meta: { at: 1000, uptimeSec: 10 },
  status: { loop: { signalsSeen: 100, accepted: 2 }, day: { trades: 6, ts: 5 } },
  limits: { stopLossPct: 0.5 },
  refusals: [{ reason: "hourly ceiling", count: 10 }],
  errors: [],
};
const j = (o: unknown) => JSON.stringify(o, null, 2);

console.log("\n## time passing is not a change");
const tick = structuredClone(base);
tick.meta.at = 99999; tick.meta.uptimeSec = 9999; tick.status.day.ts = 88;
ok("clocks moving does not count", h(j(base)) === h(j(tick)));

console.log("\n## real events are changes");
for (const [what, mut] of [
  ["a trade closed", (o: typeof base) => { o.status.day.trades = 7; }],
  ["a signal accepted", (o: typeof base) => { o.status.loop.accepted = 3; }],
  ["a setting moved", (o: typeof base) => { o.limits.stopLossPct = 0.25; }],
  ["a refusal count rose", (o: typeof base) => { o.refusals[0].count = 11; }],
  ["an error appeared", (o: typeof base) => { (o.errors as unknown[]).push({ where: "x", text: "y" }); }],
] as [string, (o: typeof base) => void][]) {
  const m = structuredClone(base); mut(m);
  ok(what, h(j(base)) !== h(j(m)));
}

console.log("\n## how much noise this removes");
// A quiet hour: 120 snapshot writes, nothing happening.
let commits = 0, last = "", lastAt = 0;
const HEARTBEAT = 15 * 60_000;
for (let i = 0; i < 120; i++) {
  const now = i * 30_000;
  const snap = structuredClone(base); snap.meta.at = now; snap.meta.uptimeSec = i * 30;
  const hh = h(j(snap));
  if (hh !== last || now - lastAt >= HEARTBEAT) { commits++; last = hh; lastAt = now; }
}
// One at the start plus one per heartbeat interval: 60 min / 15 = 4.
ok("a quiet hour makes 4 commits, not 120", commits === 4, String(commits));
ok("...so silence is still distinguishable from a dead bridge", commits > 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
