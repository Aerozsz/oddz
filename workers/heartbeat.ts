import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A small file each background worker keeps current, so the GUI can tell
 * "running and quiet" from "not running".
 *
 * Inferring liveness from the output file does not work, and produced the same
 * misreport twice: the shadow run writes nothing until its first trade resolves
 * fifteen minutes after the first trade fires, and trades only fire when the
 * bias calls a side. A worker can therefore be perfectly healthy for hours with
 * an empty — or absent — output file, and a panel that reads "not running" in
 * that state is telling the operator to go and fix something that is working.
 *
 * Absence of the heartbeat is meaningful; staleness of it is meaningful; the
 * output file is not.
 *
 * Written whole on every beat rather than appended, so a crash leaves the last
 * good state rather than a truncated line.
 */

export interface Heartbeat {
  name: string;
  pid: number;
  startedAt: number;
  /** Last write. Compared against now to decide whether the process is alive. */
  at: number;
  /** Whatever the worker wants to report, e.g. rows written, trades pending. */
  stats: Record<string, number | string | boolean | null>;
  /**
   * Set by the final beat on a clean shutdown.
   *
   * Without it the stop write re-stamps `at` with the current time, so a worker
   * that has just been Ctrl-C'd reads as alive for the next ninety seconds —
   * the exact confusion this file exists to remove, inverted.
   */
  stopped?: boolean;
}

/** A beat older than this means the process is gone or wedged. */
export const STALE_MS = 90_000;

export function heartbeatPath(name: string): string {
  return resolve(process.env.SWEEP_STATUS_DIR ?? "data", `${name}.status.json`);
}

/**
 * Start beating. Returns a function to update the reported stats.
 *
 * The timer is unref'd so it never keeps a process alive on its own — a worker
 * that has finished should exit, not linger because its heartbeat is pending.
 */
export function beat(
  name: string,
  stats: () => Heartbeat["stats"],
  intervalMs = 10_000,
): () => void {
  const path = heartbeatPath(name);
  const startedAt = Date.now();

  const write = (stopped = false) => {
    // Everything inside the guard, including collecting the stats. A monitor
    // that can kill the process it monitors is worse than no monitor, and
    // stats() reaches into live worker state that can throw during shutdown.
    try {
      const hb: Heartbeat = {
        name,
        pid: process.pid,
        startedAt,
        at: Date.now(),
        stats: stats(),
        ...(stopped ? { stopped: true } : {}),
      };
      // Written to a temporary file and renamed, because rename is atomic and
      // a plain write is not: a reader polling on its own cycle will sooner or
      // later land mid-write, fail to parse, and conclude the worker was never
      // started.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(hb)}\n`);
      renameSync(tmp, path);
    } catch {
      // A worker must not die because its status file could not be written.
    }
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* same reason: the heartbeat is never allowed to be fatal */
  }

  write();
  const timer = setInterval(write, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    write(true);
  };
}

export interface HeartbeatRead {
  running: boolean;
  /** True when a heartbeat exists but has not been updated recently. */
  stale: boolean;
  startedAt: number;
  at: number;
  ageMs: number;
  stats: Heartbeat["stats"];
  /**
   * Who is writing it.
   *
   * Needed because a worker can now legitimately host another worker's job — the
   * control server runs the news poller in-process and beats on its behalf, so
   * "is sweep-news running" and "is somebody else running it" are different
   * questions, and answering the second with the first makes the server stand
   * down in deference to itself.
   */
  pid: number;
}

export function readHeartbeat(name: string): HeartbeatRead {
  const path = heartbeatPath(name);
  const empty: HeartbeatRead = { running: false, stale: false, startedAt: 0, at: 0, ageMs: 0, stats: {}, pid: 0 };
  if (!existsSync(path)) return empty;
  try {
    const hb = JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
    const ageMs = Date.now() - hb.at;
    return {
      running: !hb.stopped && ageMs < STALE_MS,
      // A clean stop is reported as such immediately rather than waiting out
      // the staleness window.
      stale: Boolean(hb.stopped) || ageMs >= STALE_MS,
      startedAt: hb.startedAt,
      at: hb.at,
      ageMs,
      stats: hb.stats ?? {},
      pid: hb.pid ?? 0,
    };
  } catch {
    return empty;
  }
}
