import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  mkdirSync(dirname(path), { recursive: true });

  const write = () => {
    const hb: Heartbeat = { name, pid: process.pid, startedAt, at: Date.now(), stats: stats() };
    try {
      writeFileSync(path, `${JSON.stringify(hb)}\n`);
    } catch {
      // A worker must not die because its status file could not be written.
    }
  };

  write();
  const timer = setInterval(write, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    write();
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
}

export function readHeartbeat(name: string): HeartbeatRead {
  const path = heartbeatPath(name);
  const empty: HeartbeatRead = { running: false, stale: false, startedAt: 0, at: 0, ageMs: 0, stats: {} };
  if (!existsSync(path)) return empty;
  try {
    const hb = JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
    const ageMs = Date.now() - hb.at;
    return {
      running: ageMs < STALE_MS,
      stale: ageMs >= STALE_MS,
      startedAt: hb.startedAt,
      at: hb.at,
      ageMs,
      stats: hb.stats ?? {},
    };
  } catch {
    return empty;
  }
}
