import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Configuration written somewhere else and applied here.
 *
 * The operator's position is that they start and pause trading and they open and
 * close positions; everything else should be somebody else's problem. The state
 * snapshot solved half of that — it made the agent's state readable from
 * elsewhere — and left the other half exactly where it was, with settings only
 * changeable by hand in the browser.
 *
 * This is the other direction: a file in the repository that says what the risk
 * settings should be, which the control server reads and applies.
 *
 * ## What it is deliberately not allowed to do
 *
 * It cannot arm or disarm trading, it cannot open or close a position, and it
 * cannot name a contract. Those are the three things the operator reserved, and
 * a channel that could do them would be a remote control over an account rather
 * than a configuration file. `tradingEnabled` is not on the whitelist and is
 * rejected rather than ignored, so a file that tries reads as an error instead
 * of quietly doing nothing.
 *
 * It also cannot set an arbitrary number. Every value is clamped to the same
 * bounds the auto-tuner works inside, so the worst a wrong or tampered file can
 * do is move a setting somewhere the tuner could have moved it anyway.
 *
 * ## Why bounds rather than trust
 *
 * The file arrives over git. That is a channel with the operator's own
 * credentials on it, but "the transport is authenticated" is not the same as
 * "the contents are correct", and this process places real orders. Bounds hold
 * whether the file is wrong because someone made a mistake or because someone
 * meant it.
 */

/** The only keys that may be set remotely, with the range each is held inside. */
export const REMOTE_LIMITS: Record<string, { min: number; max: number; dp: number; what: string }> = {
  stopLossPct: { min: 0.1, max: 1.5, dp: 3, what: "how far the protective stop sits from entry" },
  riskPerTradePct: { min: 0.5, max: 6, dp: 2, what: "share of collateral risked per trade" },
  minRewardRisk: { min: 1, max: 3, dp: 2, what: "target distance as a multiple of the stop" },
  minRewardOverFees: { min: 1.2, max: 4, dp: 2, what: "reward as a multiple of the round trip" },
  maxHoldMinutes: { min: 10, max: 480, dp: 0, what: "time stop" },
  breakEvenAtPct: { min: 0, max: 85, dp: 0, what: "when the stop moves to break-even" },
  trailArmsAtR: { min: 0, max: 3, dp: 2, what: "when the trail starts following" },
  scaleOutAtR: { min: 0, max: 4, dp: 2, what: "when part of the position comes off" },
  scaleOutFraction: { min: 0, max: 60, dp: 0, what: "how much comes off" },
  sizeDerateStrength: { min: 0, max: 1, dp: 2, what: "how strongly conditions shrink size" },
  marginHeadroomPct: { min: 0, max: 40, dp: 1, what: "collateral kept uncommitted" },
  maxLeverage: { min: 1, max: 20, dp: 0, what: "leverage ceiling" },
  maxPositionUsd: { min: 0, max: 1_000_000, dp: 0, what: "notional ceiling; 0 means none" },
  maxOpenPositions: { min: 0, max: 4, dp: 0, what: "concurrent positions" },
};

/**
 * Never settable from here, and rejected loudly rather than dropped.
 *
 * The first three are the operator's reserved controls. The last three are the
 * stopping rules they switched off deliberately to collect data — and which
 * three separate code paths have already put back once, which is reason enough
 * to keep a fourth from being able to.
 */
export const RESERVED = [
  "tradingEnabled",
  "requireCashOpen",
  "autoTune",
  "maxDailyLossUsd",
  "maxTradesPerDay",
  "lossCooldownMin",
] as const;

export interface DesiredFile {
  /** When it was written, so an unchanged file is not reapplied. */
  at: number;
  /** Free text, carried into the audit log so the record says why. */
  reason?: string;
  limits?: Record<string, unknown>;
}

export interface DesiredChange {
  key: string;
  from: number;
  to: number;
  clamped: boolean;
  what: string;
}

export interface DesiredResult {
  changes: DesiredChange[];
  rejected: { key: string; why: string }[];
  at: number;
  reason: string;
}

export function desiredPath(): string {
  return resolve(process.env.SWEEP_DESIRED ?? "control/limits.json");
}

const round = (v: number, dp: number) => Number(v.toFixed(dp));

/**
 * Work out what would change, without changing anything.
 *
 * Separated from applying so the caller can log the whole decision before acting
 * on any of it — a partial application that is only half-recorded is worse than
 * no application, because the next pass cannot tell what happened.
 */
export function planDesired(
  current: Record<string, number | boolean>,
  file: DesiredFile,
): DesiredResult {
  const changes: DesiredChange[] = [];
  const rejected: { key: string; why: string }[] = [];

  for (const [key, raw] of Object.entries(file.limits ?? {})) {
    if ((RESERVED as readonly string[]).includes(key)) {
      rejected.push({
        key,
        why:
          key === "tradingEnabled" || key === "requireCashOpen" || key === "autoTune"
            ? "arming is the operator's, and is never set from a file"
            : "this stopping rule is the operator's and is deliberately switched off",
      });
      continue;
    }
    const bound = REMOTE_LIMITS[key];
    if (!bound) {
      rejected.push({ key, why: "not a setting that can be changed remotely" });
      continue;
    }
    /*
     * Only a number, or a string that is one. Nothing else is coerced.
     *
     * `Number(null)` is 0, and so is `Number("")`, `Number([])` and
     * `Number(false)`. Accepting whatever `Number()` returns meant a null in the
     * file set the stop to its floor rather than being refused — a value nobody
     * wrote, applied silently, to the setting that decides what a loss costs.
     */
    const numeric =
      typeof raw === "number" ? raw
      : typeof raw === "string" && raw.trim() !== "" ? Number(raw)
      : NaN;
    if (!Number.isFinite(numeric)) {
      rejected.push({ key, why: `${JSON.stringify(raw) ?? String(raw)} is not a number` });
      continue;
    }
    const want = numeric;
    const clampedValue = round(Math.min(bound.max, Math.max(bound.min, want)), bound.dp);
    const from = Number(current[key]);
    if (!Number.isFinite(from)) {
      rejected.push({ key, why: "no current value to change" });
      continue;
    }
    if (clampedValue === round(from, bound.dp)) continue;
    changes.push({
      key,
      from,
      to: clampedValue,
      clamped: clampedValue !== round(want, bound.dp),
      what: bound.what,
    });
  }

  return {
    changes,
    rejected,
    at: Number(file.at) || 0,
    reason: typeof file.reason === "string" ? file.reason.slice(0, 300) : "",
  };
}

/** Read the file, or null when there is none or it cannot be parsed. */
export function readDesired(path = desiredPath()): DesiredFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DesiredFile;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
