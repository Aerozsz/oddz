import type { SessionState } from "../types";

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

export function sessionState(now = new Date()): SessionState {
  const { weekday, minutes, secondsIntoMinute } = etParts(now);
  const msIntoMinute = secondsIntoMinute * 1000 + now.getMilliseconds();
  const toBoundary = (boundaryMinutes: number, daysAhead = 0) =>
    (boundaryMinutes + daysAhead * 1440 - minutes) * 60_000 - msIntoMinute;

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
}

/** True when the bar's open time falls inside regular Nasdaq cash hours. */
export function inRegularSession(openTime: number): boolean {
  const { weekday, minutes } = etParts(new Date(openTime));
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= OPEN_REG && minutes < CLOSE_REG;
}
