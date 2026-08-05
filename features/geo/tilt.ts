/**
 * Pure tilt math for the peace↔war dashboard. Kept dependency-free so it's
 * trivially testable and reusable by both the header gauge and the per-theater
 * strip.
 *
 * The "tilt" is the single number the whole page exists to show: where the
 * balance of Trump's recent geopolitics headlines currently sits on the
 * escalation(−)↔de-escalation(+) axis, recency- and intensity-weighted.
 */

import type { Side, Theater } from "@/lib/geo/types";

export interface TiltInput {
  side: Side;
  intensity: "low" | "medium" | "high" | "critical";
  theater: string;
  at: Date; // publishedAt ?? firstSeenAt
}

const INTENSITY_WEIGHT: Record<TiltInput["intensity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Linear recency decay across the window; floor so old-but-in-window items still count a little. */
function recency(at: Date, windowHours: number, now: number): number {
  const ageHours = (now - at.getTime()) / 3_600_000;
  return Math.max(0.2, 1 - ageHours / windowHours);
}

export interface Tilt {
  /** −100 (all escalation) … +100 (all de-escalation); 0 = balanced. */
  value: number;
  escalationWeight: number;
  deescalationWeight: number;
  escalationCount: number;
  deescalationCount: number;
  neutralCount: number;
  total: number;
}

export function computeTilt(items: TiltInput[], windowHours = 48, now = Date.now()): Tilt {
  let esc = 0;
  let deesc = 0;
  let escN = 0;
  let deescN = 0;
  let neutralN = 0;

  for (const it of items) {
    if (it.side === "neutral") {
      neutralN++;
      continue;
    }
    const w = INTENSITY_WEIGHT[it.intensity] * recency(it.at, windowHours, now);
    if (it.side === "escalation") {
      esc += w;
      escN++;
    } else {
      deesc += w;
      deescN++;
    }
  }

  const denom = esc + deesc;
  const value = denom === 0 ? 0 : Math.round(((deesc - esc) / denom) * 100);

  return {
    value,
    escalationWeight: esc,
    deescalationWeight: deesc,
    escalationCount: escN,
    deescalationCount: deescN,
    neutralCount: neutralN,
    total: items.length,
  };
}

export interface TheaterTilt {
  theater: Theater;
  tilt: number; // −100..+100
  escalationCount: number;
  deescalationCount: number;
  lastAt: Date | null;
}

export function computeTheaterTilts(
  items: (TiltInput & { theater: Theater })[],
  windowHours = 48,
  now = Date.now(),
): TheaterTilt[] {
  const byTheater = new Map<Theater, (TiltInput & { theater: Theater })[]>();
  for (const it of items) {
    const arr = byTheater.get(it.theater) ?? [];
    arr.push(it);
    byTheater.set(it.theater, arr);
  }

  const out: TheaterTilt[] = [];
  for (const [theater, arr] of byTheater) {
    const t = computeTilt(arr, windowHours, now);
    const lastAt = arr.reduce<Date | null>((max, it) => (!max || it.at > max ? it.at : max), null);
    out.push({
      theater,
      tilt: t.value,
      escalationCount: t.escalationCount,
      deescalationCount: t.deescalationCount,
      lastAt,
    });
  }

  // Most-active theaters first.
  out.sort(
    (a, b) =>
      b.escalationCount + b.deescalationCount - (a.escalationCount + a.deescalationCount),
  );
  return out;
}

/** Human label for the overall tilt number. */
export function tiltLabel(value: number): string {
  if (value <= -60) return "Heavy escalation";
  if (value <= -20) return "Leaning escalation";
  if (value < 20) return "Balanced";
  if (value < 60) return "Leaning de-escalation";
  return "Heavy de-escalation";
}
