import { MarkoutTracker } from "@/lib/sweep/metrics/markout";
import { estimateCarry, fundingSkew, inferIntervalHours, readFunding } from "@/lib/sweep/metrics/funding";
import { calendar, eventRisk, parseEnvEvents } from "@/lib/sweep/metrics/events";
import { WEIGHTS, sessionState, sessionWeightsAt } from "@/lib/sweep/metrics/session";
import { WithdrawalTracker } from "@/lib/sweep/metrics/withdrawal";
import type { MarkPrice, Trade } from "@/lib/sweep/types";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const trade = (t: number, price: number, notional: number, aggressor: "buy" | "sell"): Trade => ({
  t,
  price,
  qty: notional / price,
  notional,
  buyerIsMaker: aggressor === "sell",
});

/* ----------------------------------------------------------------- markout */

console.log("\n## mark-out");

{
  // Informed buying: every buy is followed by a higher mid.
  const m = new MarkoutTracker();
  let t = 1_000_000;
  let mid = 100;
  for (let i = 0; i < 120; i++) {
    m.onTrade(trade(t, mid, 5_000, "buy"), t);
    // Drive the clock forward past the longest horizon, lifting the mid.
    for (let k = 0; k < 320; k++) {
      t += 100;
      mid += 0.0004;
      m.onMid(t, mid, 2); // 2bp spread => 1bp half-spread
    }
  }
  const r = m.read(t);
  ok("warms after enough resolved prints", r.warm);
  ok("informed buying scores positive", r.informed > 0.5, `informed=${r.informed.toFixed(3)}`);
  ok("regime is not benign", r.regime !== "benign", r.regime);
  ok("5s mark-out is positive", (r.horizons[1].costToMakerBps ?? 0) > 0, `${r.horizons[1].costToMakerBps?.toFixed(2)}bp`);
}

{
  // Uninformed two-sided flow around a flat mid: nobody is right.
  const m = new MarkoutTracker();
  let t = 2_000_000;
  const mid = 100;
  for (let i = 0; i < 120; i++) {
    // Aggressors pay the spread: buys at the offer, sells at the bid.
    m.onTrade(trade(t, mid + 0.01, 5_000, "buy"), t);
    m.onTrade(trade(t, mid - 0.01, 5_000, "sell"), t);
    for (let k = 0; k < 320; k++) {
      t += 100;
      m.onMid(t, mid, 2);
    }
  }
  const r = m.read(t);
  ok("balanced flow has no direction", Math.abs(r.informed) < 0.2, `informed=${r.informed.toFixed(3)}`);
  ok("aggressors paying the spread are not toxic", r.regime === "benign", r.regime);
  ok("cost to maker is negative (maker earns)", (r.horizons[1].costToMakerBps ?? 1) < 0);
}

{
  // Own-fill quality.
  const m = new MarkoutTracker();
  let t = 3_000_000;
  m.recordFill({ t, side: "buy", price: 100.05, notional: 10_000, arrivalMid: 100.0 });
  for (let k = 0; k < 400; k++) {
    t += 100;
    m.onMid(t, 100.2, 2);
  }
  const q = m.fillQuality();
  ok("slippage measured against arrival mid", Math.abs((q.slippageBps ?? 0) - 5) < 0.1, `${q.slippageBps?.toFixed(2)}bp`);
  ok("own mark-out favourable when price rose after a buy", (q.markoutBps ?? 0) > 0, `${q.markoutBps?.toFixed(2)}bp`);
}

/* ----------------------------------------------------------------- funding */

console.log("\n## funding");

{
  const eightHourly = Array.from({ length: 30 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 8 * 3_600_000,
    rate: 0.0001,
  }));
  ok("infers 8h from history", inferIntervalHours(eightHourly) === 8);

  const fourHourly = Array.from({ length: 30 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 4 * 3_600_000,
    rate: 0.0001,
  }));
  ok("infers 4h from history", inferIntervalHours(fourHourly) === 4);
  ok("falls back to 8h with no history", inferIntervalHours([]) === 8);
}

{
  const now = 1_800_000_000_000;
  // A history of tiny rates, then a big positive one now: stretched, longs crowded.
  const history = Array.from({ length: 60 }, (_, i) => ({
    time: now - (60 - i) * 8 * 3_600_000,
    rate: 0.00001 * ((i % 5) - 2),
  }));
  const mark: MarkPrice = {
    markPrice: 101.5,
    indexPrice: 101.0,
    fundingRate: 0.0008,
    nextFundingTime: now + 20 * 60_000,
    t: now,
  };
  const f = readFunding(mark, history, now);
  ok("longs identified as payers", f.paying === "longs", f.paying);
  ok("rate reads as stretched", f.stretched, `percentile=${f.percentile?.toFixed(2)}`);
  ok("crowded side is longs", f.crowded === "longs");
  ok("skew is negative (fuel below the crowd)", fundingSkew(f) < 0, `${fundingSkew(f).toFixed(3)}`);
  ok("basis computed", Math.abs(f.basisBps - 49.5) < 1, `${f.basisBps.toFixed(1)}bp`);
  ok("annualised uses the inferred interval", Math.abs(f.annualisedPct - 0.0008 * 1095 * 100) < 1);

  // The step function: nothing before settlement, the whole rate after.
  const before = estimateCarry(f, "long", 100_000, 19 * 60_000, now);
  const after = estimateCarry(f, "long", 100_000, 21 * 60_000, now);
  ok("no funding when the hold ends before settlement", before.free && before.costUsd === 0, before.note);
  ok("full rate the moment settlement is crossed", Math.abs(after.costUsd - 80) < 0.01, `$${after.costUsd.toFixed(2)}`);
  ok("a short receives what a long pays", estimateCarry(f, "short", 100_000, 21 * 60_000, now).costUsd === -80);

  const twoDay = estimateCarry(f, "long", 100_000, 25 * 3_600_000, now);
  ok("counts every settlement crossed", twoDay.settlements === 4, `${twoDay.settlements}`);

  // A flat rate must produce no positioning signal at all.
  const flat = readFunding({ ...mark, fundingRate: 0.000005 }, history, now);
  ok("flat rate is not a signal", flat.paying === "neither" && fundingSkew(flat) === 0);
}

/* ----------------------------------------------------------------- session */

console.log("\n## session");

{
  // 14:00 UTC on a Wednesday = 10:00 ET (EDT) — the morning phase.
  const morning = sessionState(new Date("2026-08-05T14:30:00Z"));
  ok("mid-morning is the morning phase", morning.intraday === "morning", morning.intraday);
  ok("morning is cash-open", morning.cashOpen);

  const openAuction = sessionState(new Date("2026-08-05T13:32:00Z")); // 09:32 ET
  ok("just after the bell is the opening auction", openAuction.intraday === "open-auction", openAuction.intraday);
  ok("opening auction expects high volatility", openAuction.weights.volScale > 2);
  ok("opening auction sizes down", openAuction.weights.sizeScale < 0.7);
  ok("first minutes of a phase flag as transitioning", openAuction.transitioning);

  const settled = sessionState(new Date("2026-08-05T13:50:00Z")); // 09:50 ET
  ok("later in the same phase is not transitioning", !settled.transitioning);

  const overnight = sessionState(new Date("2026-08-05T04:00:00Z")); // 00:00 ET
  ok("small hours are overnight", overnight.intraday === "overnight", overnight.intraday);
  ok("overnight expects a fraction of the depth", overnight.weights.depthScale < 0.3);

  const closeRamp = sessionState(new Date("2026-08-05T19:45:00Z")); // 15:45 ET
  ok("last half hour is the close ramp", closeRamp.intraday === "close-ramp", closeRamp.intraday);

  const weekend = sessionState(new Date("2026-08-08T18:00:00Z")); // Saturday
  ok("saturday is the weekend phase", weekend.intraday === "weekend", weekend.intraday);
  ok("weekend never flags as transitioning", !weekend.transitioning);

  ok("every phase has weights", Object.values(WEIGHTS).every((w) => w.depthScale > 0 && w.sizeScale > 0));
  ok("weightsAt agrees with sessionState", sessionWeightsAt(Date.parse("2026-08-05T14:30:00Z")).sizeScale === morning.weights.sizeScale);
}

{
  // The false positive this exists to kill: depth halving because the cash
  // market shut must not read as a withdrawal.
  const raw = new WithdrawalTracker();
  const adjusted = new WithdrawalTracker();
  let t = 1_000_000;

  // Ten minutes of cash-session depth at scale 1.0.
  for (let i = 0; i < 1200; i++) {
    raw.sample(t, 100_000, 100_000, 100);
    adjusted.sample(t, 100_000, 100_000, 100, 1.0);
    t += 500;
  }
  // The close: depth drops to 30%, and so does the expectation.
  for (let i = 0; i < 20; i++) {
    raw.sample(t, 30_000, 30_000, 100);
    adjusted.sample(t, 30_000, 30_000, 100, 0.3);
    t += 500;
  }

  const rawIdx = raw.index();
  const adjIdx = adjusted.index();
  ok("raw index reports a collapse", rawIdx.total < 0.45, `lwi=${rawIdx.total.toFixed(2)}`);
  ok(
    "session-adjusted index reports normality",
    Math.abs(adjIdx.total * adjIdx.sessionAdj - 1) < 0.25,
    `lwiAdj=${(adjIdx.total * adjIdx.sessionAdj).toFixed(2)}`,
  );

  // And a genuine pull, at constant session scale, must still show.
  const real = new WithdrawalTracker();
  let t2 = 1_000_000;
  for (let i = 0; i < 1200; i++) {
    real.sample(t2, 100_000, 100_000, 100, 1.0);
    t2 += 500;
  }
  for (let i = 0; i < 20; i++) {
    real.sample(t2, 30_000, 30_000, 100, 1.0);
    t2 += 500;
  }
  const realIdx = real.index();
  ok(
    "a real pull still reads as thin after adjustment",
    realIdx.total * realIdx.sessionAdj < 0.5,
    `lwiAdj=${(realIdx.total * realIdx.sessionAdj).toFixed(2)}`,
  );
}

/* ------------------------------------------------------------------ events */

console.log("\n## events");

{
  const now = Date.parse("2026-08-06T12:00:00Z");
  const cal = calendar(now);
  ok("projects future earnings", cal.length > 0, `${cal.length} entries`);
  ok("all projections are in the future", cal.every((e) => e.at > now));
  ok("projections are flagged as such", cal.every((e) => e.certainty === "projected"));
  ok("projections carry uncertainty", cal.every((e) => e.uncertaintyDays >= 7));
  ok("dates are ordered", cal.every((e, i) => i === 0 || e.at >= cal[i - 1].at));
  const first = new Date(cal[0].at);
  ok("first projection is a Thursday", first.getUTCDay() === 4, first.toUTCString());

  const far = eventRisk(now);
  ok("far from any date, nothing is derated", far.sizeScale === 1 && !far.blackout);
  ok("a projected date never blacks out", !far.blackout);

  // Inside a projected window: derated but never zero.
  const nearProjected = eventRisk(cal[0].at - 2 * 86_400_000);
  ok("inside the estimated window, size is cut", nearProjected.sizeScale < 1, `${nearProjected.sizeScale.toFixed(2)}`);
  ok("but never to zero on a guess", nearProjected.sizeScale >= 0.25);
  ok("and it asks to be confirmed", nearProjected.needsConfirmation);
  ok("still no hard blackout on a guess", !nearProjected.blackout);
}

{
  const at = Date.parse("2026-09-24T20:05:00Z");
  const confirmed = parseEnvEvents(
    JSON.stringify([{ id: "q3", label: "Intel Q3", at: "2026-09-24T20:05:00Z", certainty: "confirmed" }]),
  );
  ok("env events parse", confirmed.events.length === 1 && confirmed.error === null);
  ok("env event keeps its timestamp", confirmed.events[0].at === at);

  const inside = eventRisk(at - 60 * 60_000, confirmed.events);
  ok("a confirmed date blacks out", inside.blackout && inside.sizeScale === 0, inside.reason ?? "");

  const after = eventRisk(at + 20 * 3_600_000, confirmed.events);
  ok("blackout ends after the window", !after.blackout);

  const dayBefore = eventRisk(at - 20 * 3_600_000, confirmed.events);
  ok("approaching a known date tapers size", dayBefore.sizeScale < 1 && !dayBefore.blackout, `${dayBefore.sizeScale.toFixed(2)}`);

  ok("malformed env is reported, not thrown", parseEnvEvents("{not json").error !== null);
  ok("non-array env is rejected", parseEnvEvents('{"a":1}').error !== null);
  ok("empty env is fine", parseEnvEvents(undefined).events.length === 0 && parseEnvEvents(undefined).error === null);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
