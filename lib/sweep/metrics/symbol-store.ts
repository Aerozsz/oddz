import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SYMBOLS } from "../config";

/**
 * Which contracts are being watched, as state rather than as configuration.
 *
 * It was an environment variable, which made changing it a restart: edit the
 * command, stop the server, start it again, and lose the warm baselines on
 * every other desk in the process. Those baselines are not incidental — the
 * withdrawal metrics, the mark-out and the shock detector all need minutes of
 * history before they mean anything, so restarting to add a symbol silently
 * blinds the ones already running for as long as it takes them to warm back up.
 *
 * `SWEEP_SYMBOLS` still works and is still the source of truth on a fresh
 * install. Once the list has been edited from the page, the file wins — the
 * alternative is a control that appears to work and is quietly reverted by the
 * command line on the next restart, which is worse than no control.
 */

/** More than this is a rate limit, not a strategy. */
export const MAX_SYMBOLS = 8;

export function symbolsPath(): string {
  return resolve(process.env.SWEEP_SYMBOLS_FILE ?? "data/sweep-symbols.json");
}

export function normalise(symbol: string): string {
  return String(symbol ?? "").trim().toUpperCase();
}

/**
 * The watched list: the file if one has been written, the environment if not.
 *
 * Never returns empty. A server with no desks has no reason to be running, and
 * an empty list would present as a working page with nothing on it — so an
 * emptied file falls back to the environment rather than being honoured.
 */
export function readSymbols(path = symbolsPath()): string[] {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { symbols?: unknown };
      const list = Array.isArray(parsed?.symbols) ? parsed.symbols : [];
      const clean = [...new Set(list.map(normalise).filter(Boolean))].slice(0, MAX_SYMBOLS);
      if (clean.length > 0) return clean;
    } catch {
      // A corrupt file must not take the server down; the environment is a
      // perfectly good answer and the operator can see the file is wrong.
    }
  }
  return [...SYMBOLS];
}

export function writeSymbols(symbols: string[], path = symbolsPath()): string[] {
  const clean = [...new Set(symbols.map(normalise).filter(Boolean))].slice(0, MAX_SYMBOLS);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Written whole and renamed, because rename is atomic: a reader landing
  // mid-write would otherwise parse nothing and fall back to the environment,
  // which looks exactly like the edit having been ignored.
  writeFileSync(tmp, `${JSON.stringify({ symbols: clean }, null, 2)}\n`);
  renameSync(tmp, path);
  return clean;
}
