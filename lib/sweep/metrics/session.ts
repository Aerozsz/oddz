import type { IntradayPhase, SessionState, SessionWeights } from "../types";

/**
 * INTCUSDT trades 24/7 but Intel does not. When Nasdaq is closed the perp has
 * no arbitrage anchor and no cash-market maker to lean on, so depth is
 * structurally thinner and the price it takes to reach the first trigger
 * cluster is structurally lower. Session phase is therefore a first-class part
 * of reading everything else on this page.
 *
 * Half-days and market holidays are not modelled; the phase shown is the
 * regular weekday schedule in US Eastern.
 */

const OPEN_PRE = 4 * 60; // 04:00 ET
const OPEN_REG = 9 * 60 + 30; // 09:30 ET
const CLOSE_REG = 16 * 60; // 16:00 ET
const CLOSE_POST = 20 * 60; // 20:00 ET

interface EtParts {
  weekday: number; // 0 = Sunday
  minutes: number;
  secondsIntoMinute: number;
}

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/* --------------------------------------------------------- intraday shape */

/**
 * Intraday boundaries, in ET minutes. These are the equity market's shape, not
 * the perp's, and that is the point: the perp's depth is supplied by people who
 * can hedge in the cash market, so it inherits the cash market's clock even
 * though it never closes.
 */
const OPEN_AUCTION_END = 10 * 60; // 10:00 — the opening imbalance is worked out
const MIDDAY_START = 12 * 60;
const MIDDAY_END = 14 * 60;
const CLOSE_RAMP_START = 15 * 60 + 30; // MOC imbalances start publishing

/**
 * Per-phase multipliers.
 *
 * These are priors, not fitted parameters, and the distinction matters enough
 * to put in the file: they encode the well-documented U-shape of intraday
 * equity liquidity and volatility, scaled so that the regular session averages
 * to 1. They have not been estimated from this contract's own history, because
 * that history does not exist yet — the paper log is what will eventually
 * replace them, and until it does these are a considered starting point rather
 * than a measurement.
 *
 * What each one does, and — as importantly — where it is *not* used:
 *
 *  - `depthScale`  what depth to expect, so the withdrawal index can tell a
 *                  session change apart from an actual pull. This fixes a real
 *                  false positive: without it every 16:00 close reads as a mass
 *                  withdrawal on both sides.
 *  - `volScale`    applied to the realised-volatility figure that sets stop
 *                  width, and only while `transitioning`. Realised vol is a
 *                  backward-looking window, so for the first minutes after a
 *                  boundary it is still describing the phase that ended; this
 *                  covers exactly that gap and then gets out of the way.
 *  - `sizeScale`   multiplier on position size. The one blunt instrument here.
 *
 * There is deliberately no risk multiplier. The cascade cost is computed from
 * the real book, which is already thin overnight, so the cheap seed *is* the
 * session effect — scaling the risk score for the same reason would count it
 * twice. And whether a thin overnight book is more likely to be swept or simply
 * has nobody around to sweep it is a question this tool has no data on yet.
 */
export const WEIGHTS: Record<IntradayPhase, SessionWeights> = {
  // Wide spreads, real information, and the day's positioning being established.
  "open-auction": { depthScale: 0.8, volScale: 2.2, sizeScale: 0.6 },
  morning: { depthScale: 1.15, volScale: 1.1, sizeScale: 1 },
  // Thin participation but thin volatility with it; the ratio is what matters.
  midday: { depthScale: 1, volScale: 0.6, sizeScale: 0.9 },
  afternoon: { depthScale: 1.05, volScale: 0.9, sizeScale: 1 },
  // Closing-auction imbalances move price on flow that has nothing to say.
  "close-ramp": { depthScale: 0.9, volScale: 1.6, sizeScale: 0.7 },
  "pre-market": { depthScale: 0.35, volScale: 1.3, sizeScale: 0.4 },
  "after-hours": { depthScale: 0.3, volScale: 1.2, sizeScale: 0.35 },
  // Nothing to hedge against and nobody to hedge with.
  overnight: { depthScale: 0.2, volScale: 0.8, sizeScale: 0.25 },
  weekend: { depthScale: 0.15, volScale: 0.7, sizeScale: 0.2 },
};

/** A phase boundary this recent means the baselines are still catching up. */
const TRANSITION_MS = 5 * 60_000;

function intradayPhase(weekday: number, minutes: number): { phase: IntradayPhase; startMin: number } {
  if (weekday === 0 || weekday === 6) return { phase: "weekend", startMin: 0 };
  if (minutes < OPEN_PRE) return { phase: "overnight", startMin: CLOSE_POST - 1440 };
  if (minutes < OPEN_REG) return { phase: "pre-market", startMin: OPEN_PRE };
  if (minutes < OPEN_AUCTION_END) return { phase: "open-auction", startMin: OPEN_REG };
  if (minutes < MIDDAY_START) return { phase: "morning", startMin: OPEN_AUCTION_END };
  if (minutes < MIDDAY_END) return { phase: "midday", startMin: MIDDAY_START };
  if (minutes < CLOSE_RAMP_START) return { phase: "afternoon", startMin: MIDDAY_END };
  if (minutes < CLOSE_REG) return { phase: "close-ramp", startMin: CLOSE_RAMP_START };
  if (minutes < CLOSE_POST) return { phase: "after-hours", startMin: CLOSE_REG };
  return { phase: "overnight", startMin: CLOSE_POST };
}

function etParts(now: Date): EtParts {
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  return {
    weekday: WEEKDAYS[get("weekday")] ?? 1,
    minutes: hour * 60 + minute,
    secondsIntoMinute: second,
  };
}

/**
 * The session shown before the engine has published anything.
 *
 * /sweep is prerendered, so any clock read during the first render is baked
 * into the static HTML at build time and then recomputed in the browser at
 * hydration — two different answers for the same markup. This placeholder is
 * constant, so both sides agree; the real phase arrives with the first publish
 * a tenth of a second later.
 */
export const PLACEHOLDER_SESSION: SessionState = {
  cashOpen: false,
  phase: "closed",
  msToNext: 0,
  nextLabel: "pre-market opens",
  intraday: "overnight",
  weights: WEIGHTS.overnight,
  msSincePhaseStart: 0,
  transitioning: false,
};

export function sessionState(now = new Date()): SessionState {
  const { weekday, minutes, secondsIntoMinute } = etParts(now);
  const msIntoMinute = secondsIntoMinute * 1000 + now.getMilliseconds();
  const { phase: intraday, startMin } = intradayPhase(weekday, minutes);
  const msSincePhaseStart = (minutes - startMin) * 60_000 + msIntoMinute;
  const toBoundary = (boundaryMinutes: number, daysAhead = 0) =>
    (boundaryMinutes + daysAhead * 1440 - minutes) * 60_000 - msIntoMinute;

  const extra = {
    intraday,
    weights: WEIGHTS[intraday],
    msSincePhaseStart,
    // The depth baselines are ten-minute EWMAs, so for a few minutes after a
    // boundary they are still describing the phase that just ended. Anything
    // reading thinness against them has to know that.
    transitioning: intraday !== "weekend" && msSincePhaseStart < TRANSITION_MS,
  };

  const base = (): Omit<SessionState, keyof typeof extra> => {
  if (weekday === 6 || weekday === 0) {
    const daysToMonday = weekday === 6 ? 2 : 1;
    return {
      cashOpen: false,
      phase: "weekend",
      msToNext: toBoundary(OPEN_PRE, daysToMonday),
      nextLabel: "pre-market opens",
    };
  }

  if (minutes < OPEN_PRE) {
    return { cashOpen: false, phase: "closed", msToNext: toBoundary(OPEN_PRE), nextLabel: "pre-market opens" };
  }
  if (minutes < OPEN_REG) {
    return { cashOpen: false, phase: "pre-market", msToNext: toBoundary(OPEN_REG), nextLabel: "cash open" };
  }
  if (minutes < CLOSE_REG) {
    return { cashOpen: true, phase: "regular", msToNext: toBoundary(CLOSE_REG), nextLabel: "cash close" };
  }
  if (minutes < CLOSE_POST) {
    return { cashOpen: false, phase: "after-hours", msToNext: toBoundary(CLOSE_POST), nextLabel: "after-hours ends" };
  }
  const daysAhead = weekday === 5 ? 3 : 1;
  return {
    cashOpen: false,
    phase: "closed",
    msToNext: toBoundary(OPEN_PRE, daysAhead),
    nextLabel: "pre-market opens",
  };
  };

  return { ...base(), ...extra };
}

/** Weights for an arbitrary instant — used when replaying the paper log. */
export function sessionWeightsAt(t: number): SessionWeights {
  const { weekday, minutes } = etParts(new Date(t));
  return WEIGHTS[intradayPhase(weekday, minutes).phase];
}

/** True when the bar's open time falls inside regular Nasdaq cash hours. */
export function inRegularSession(openTime: number): boolean {
  const { weekday, minutes } = etParts(new Date(openTime));
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= OPEN_REG && minutes < CLOSE_REG;
}
