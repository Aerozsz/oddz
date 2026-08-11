import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read .env into process.env.
 *
 * The workers run under tsx with no framework around them, so nothing puts
 * .env into the environment on their behalf — Next.js does it for the website,
 * and that is easy to assume applies here too. It does not. This lived inside
 * sweep-check.ts for a while, which produced the worst possible symptom: the
 * one command whose job is to say whether the credentials work found them, and
 * every command that actually needed them reported "no credentials".
 *
 * Server-side only. Never import this from anything that reaches the browser
 * bundle — node:fs there is a build error, not a runtime one.
 *
 * Deliberately small rather than a dependency: KEY=value, # comments, blank
 * lines, and surrounding quotes stripped. Quotes are tolerated rather than
 * rejected because pasting them in is the commonest way this file gets written
 * wrong, and an authentication failure that names nothing is a poor way to
 * find out.
 *
 * A value already in the real environment always wins, so an inline
 * `BINANCE_LIVE=1 npm run ...` is not silently overridden by the file.
 */
export function loadEnv(path = resolve(".env")): {
  found: boolean;
  count: number;
  applied: number;
  path: string;
} {
  if (!existsSync(path)) return { found: false, count: 0, applied: 0, path };
  let count = 0;
  let applied = 0;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
      if (value) applied++;
    }
    /*
     * Counted whoever set it.
     *
     * `applied` alone was the answer for as long as these commands were started
     * by hand. Under the supervisor they are not: keepalive loads .env, spawns
     * control with that environment, and control's own load then applies
     * nothing because every key is already present. The self-check read that as
     * ".env loaded — 0 values" and flagged it `bad` on a machine that was
     * trading perfectly well — a false alarm that, on an unattended run, sends
     * the next session to the top of its list to fix nothing.
     *
     * What the check actually wants to know is whether the values are there.
     */
    if (process.env[key]) count++;
  }
  return { found: true, count, applied, path };
}
