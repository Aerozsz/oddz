/**
 * What a configuration file arriving over git is allowed to do.
 *
 * This channel can change the settings a live trading process sizes orders with,
 * so the rejections matter more than the happy path. Two things it must never be
 * able to do: arm or disarm, or set a number outside the range the auto-tuner is
 * held inside. The stopping rules used to be a third; see the note below the
 * arming section for why that changed and what replaced it.
 */
import { planDesired, REMOTE_LIMITS, RESERVED } from "../lib/sweep/agent/desired";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const current = {
  stopLossPct: 0.5, riskPerTradePct: 4, minRewardRisk: 2, minRewardOverFees: 2,
  maxHoldMinutes: 120, breakEvenAtPct: 60, trailArmsAtR: 1, scaleOutAtR: 1.5,
  scaleOutFraction: 40, sizeDerateStrength: 0.5, marginHeadroomPct: 5,
  maxLeverage: 10, maxPositionUsd: 32845, maxOpenPositions: 1,
  tradingEnabled: true, maxDailyLossUsd: 0, maxTradesPerDay: 0, lossCooldownMin: 0,
  requireCashOpen: false, autoTune: false,
};

console.log("\n## the ordinary case");
let p = planDesired(current, { at: 1, reason: "tighter stop", limits: { stopLossPct: 0.25 } });
ok("a permitted setting changes", p.changes.length === 1 && p.changes[0].to === 0.25, JSON.stringify(p.changes));
ok("nothing was rejected", p.rejected.length === 0);
ok("the reason is carried for the audit", p.reason === "tighter stop");

console.log("\n## arming is never settable from a file");
p = planDesired(current, { at: 2, limits: { tradingEnabled: false } });
ok("disarming is refused", p.changes.length === 0 && p.rejected.length === 1, JSON.stringify(p.rejected));
ok("...and says why", /arming is the operator/.test(p.rejected[0].why), p.rejected[0].why);
p = planDesired(current, { at: 3, limits: { tradingEnabled: true } });
ok("arming is refused too", p.changes.length === 0);

/*
 * The stopping rules are settable now, and that is a deliberate reversal.
 *
 * They were whitelisted out because three separate code paths had put a daily
 * loss budget back onto an account that switched it off on purpose, and no
 * amount of care in those paths had stopped it happening. The operator has since
 * asked for every setting to be reachable without them touching the machine.
 * The original hazard was code silently reverting a decision; a file carrying a
 * reason string, an audit line and a log entry is the opposite of silent, so the
 * protection moves from "impossible" to "recorded".
 *
 * What must not regress is the recording. A change that cannot be written to the
 * audit is still refused — that check lives in applyDesired — and arming is
 * still not a setting.
 */
console.log("\n## the stopping rules are settable, and every change is accounted for");
for (const k of ["maxDailyLossUsd", "maxTradesPerDay", "lossCooldownMin"]) {
  p = planDesired(current, { at: 4, limits: { [k]: 500 } });
  ok(`${k} can now be set`, p.changes.length === 1 && p.rejected.length === 0,
    JSON.stringify({ changes: p.changes, rejected: p.rejected }));
  ok(`${k} carries what it does`, Boolean(p.changes[0]?.what), JSON.stringify(p.changes[0]));
}

console.log("\n## the two behavioural flags travel as 0 and 1");
for (const k of ["requireCashOpen", "autoTune"]) {
  p = planDesired({ ...current, [k]: false }, { at: 41, limits: { [k]: 1 } });
  ok(`${k} can be turned on`, p.changes.length === 1 && p.changes[0].to === 1,
    JSON.stringify({ changes: p.changes, rejected: p.rejected }));
}

console.log("\n## arming is still not a setting");
p = planDesired(current, { at: 42, limits: { tradingEnabled: 1 } });
ok("tradingEnabled is refused", p.changes.length === 0 && p.rejected.length === 1,
  JSON.stringify(p.rejected));
ok("...and says why", /operator/.test(p.rejected[0]?.why ?? ""), p.rejected[0]?.why ?? "");

console.log("\n## everything reserved is actually in the reject list");
for (const k of RESERVED) {
  p = planDesired(current, { at: 5, limits: { [k]: 1 } });
  ok(`${k} is reserved`, p.changes.length === 0, JSON.stringify(p.changes));
}

console.log("\n## values are clamped, not trusted");
p = planDesired(current, { at: 6, limits: { riskPerTradePct: 95 } });
ok("an absurd risk is clamped to the ceiling", p.changes[0].to === REMOTE_LIMITS.riskPerTradePct.max,
  String(p.changes[0].to));
ok("...and flagged as clamped", p.changes[0].clamped);
p = planDesired(current, { at: 7, limits: { maxLeverage: 500 } });
ok("leverage is clamped", p.changes[0].to === 20, String(p.changes[0].to));
p = planDesired(current, { at: 8, limits: { stopLossPct: -5 } });
ok("a negative stop is clamped to the floor", p.changes[0].to === 0.1, String(p.changes[0].to));

console.log("\n## junk is rejected rather than coerced");
for (const [k, v] of [["stopLossPct", "0.3"], ["stopLossPct", null], ["stopLossPct", {}], ["stopLossPct", NaN], ["stopLossPct", ""], ["stopLossPct", []], ["stopLossPct", false], ["stopLossPct", true]] as [string, unknown][]) {
  p = planDesired(current, { at: 9, limits: { [k]: v } });
  // An empty string is not a number, whatever Number("") says.
  const numeric = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
  ok(`${JSON.stringify(v)} ${numeric ? "is read as a number" : "is refused"}`,
    numeric ? p.changes.length === 1 : p.rejected.length === 1,
    JSON.stringify(p.rejected.concat(p.changes as never[])));
}
p = planDesired(current, { at: 10, limits: { somethingElse: 3 } });
ok("an unknown key is refused", p.rejected.length === 1 && /not a setting/.test(p.rejected[0].why));

console.log("\n## no change is not a change");
p = planDesired(current, { at: 11, limits: { stopLossPct: 0.5 } });
ok("setting a value to what it already is does nothing", p.changes.length === 0);

console.log("\n## an empty or absent file is inert");
ok("no limits key", planDesired(current, { at: 12 }).changes.length === 0);
ok("empty limits", planDesired(current, { at: 13, limits: {} }).changes.length === 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
