/**
 * Fetch Binance's public history, so the strategy can be tested on years
 * instead of discovered one trade at a time.
 *
 *   npm run sweep:history                     # last 90 days of BTCUSDT
 *   npm run sweep:history -- --symbol BTCUSDT --days 720
 *   npm run sweep:history -- --from 2023-01-01 --to 2023-12-31
 *
 * ## Why this exists
 *
 * The entry rule has a threshold in it — `DEAD_ZONE = 0.12` in bias.ts — that
 * nobody measured. It was chosen, and then the account spent a week finding out
 * about it at roughly ten dollars a trade, twenty-eight trades deep, which is a
 * sample too small to move it with. Binance publishes the data to answer it
 * properly, for nothing, going back to 2019.
 *
 * ## What is downloaded, and why those files
 *
 * `bookDepth` is the one that matters. One row per minute per band, giving the
 * notional resting within 1%, 2%, 3%, 4% and 5% of mid on each side. That is a
 * coarser version of exactly what the live tracker measures: depth on one side
 * against its own recent baseline. It is not full L2 and it does not need to be
 * — the entry rule reads a ratio against a trailing baseline, and that ratio
 * survives the coarser sampling.
 *
 * `klines` at one minute supplies the forward returns each snapshot is scored
 * against, plus the high and low needed to say whether a stop or a target would
 * have been touched first.
 *
 * `liquidationSnapshot` is the ground truth this whole strategy is named after:
 * the actual forced closes, with size and price. The cascade model has been
 * predicting these without ever being scored against one.
 *
 * ## Why it runs here and not where the analysis runs
 *
 * The analysis does not run on a machine with an outbound route to Binance;
 * this one does, because it is already streaming from it. So the download and
 * the replay happen here, and only the derived per-signal rows travel — those
 * are small, and they are the part anyone wants to read.
 *
 * No API key. This archive is public and unauthenticated, which is also why
 * nothing here touches .env or the trading path.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const BASE = "https://data.binance.vision/data/futures/um";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const symbol = arg("symbol", "BTCUSDT").toUpperCase();
const outDir = resolve(arg("out", "data/history"));
const force = process.argv.includes("--force");

/* ------------------------------------------------------------------ dates */

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateRange(): string[] {
  const to = arg("to", "");
  const from = arg("from", "");
  const days = Number(arg("days", "90"));

  /*
   * Yesterday, not today.
   *
   * A day's file is published after that day closes in UTC, so asking for today
   * is a guaranteed 404 that looks exactly like the symbol being wrong. Ending
   * on yesterday makes a 404 mean something.
   */
  const end = to ? new Date(`${to}T00:00:00Z`) : new Date(Date.now() - 24 * 3_600_000);
  const start = from
    ? new Date(`${from}T00:00:00Z`)
    : new Date(end.getTime() - (days - 1) * 24 * 3_600_000);

  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3_600_000) {
    out.push(ymd(new Date(t)));
  }
  return out;
}

/* --------------------------------------------------------------- download */

interface Fetched {
  kind: string;
  date: string;
  path: string;
  bytes: number;
  status: "cached" | "downloaded" | "missing" | "failed";
  detail?: string;
}

/**
 * One file, with the checksum Binance publishes beside it.
 *
 * The checksum is not ceremony. A truncated zip from a dropped connection
 * unpacks to a shorter file rather than an error, and a backtest quietly missing
 * six hours of a day is worse than one that fails — it produces a number, and
 * the number looks fine.
 */
async function grab(kind: string, date: string, subpath: string): Promise<Fetched> {
  const name = `${symbol}-${kind}-${date}.zip`;
  const url = `${BASE}/daily/${subpath}/${name}`;
  const dest = resolve(outDir, kind, name);

  if (!force && existsSync(dest) && statSync(dest).size > 0) {
    return { kind, date, path: dest, bytes: statSync(dest).size, status: "cached" };
  }

  mkdirSync(dirname(dest), { recursive: true });
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      return { kind, date, path: dest, bytes: 0, status: "missing", detail: "not published for this date" };
    }
    if (!res.ok) {
      return { kind, date, path: dest, bytes: 0, status: "failed", detail: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);

    // Verify against the published checksum when it is there; a missing .CHECKSUM
    // is not a failure, it is an older part of the archive.
    try {
      const sumRes = await fetch(`${url}.CHECKSUM`);
      if (sumRes.ok) {
        const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
        const actual = createHash("sha256").update(buf).digest("hex");
        if (expected && expected !== actual) {
          return { kind, date, path: dest, bytes: buf.length, status: "failed", detail: "checksum mismatch" };
        }
      }
    } catch {
      /* the file itself is fine; only the verification was unavailable */
    }

    return { kind, date, path: dest, bytes: buf.length, status: "downloaded" };
  } catch (err) {
    return {
      kind, date, path: dest, bytes: 0, status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------- main */

/**
 * What to pull, and where it lives in the archive's layout.
 *
 * `bookDepth` and `liquidationSnapshot` are daily-only; klines are published
 * both ways but daily keeps one code path and the volume is manageable.
 */
const KINDS: { kind: string; subpath: string; why: string }[] = [
  { kind: "bookDepth", subpath: `bookDepth/${symbol}`, why: "depth per side per minute" },
  { kind: "1m", subpath: `klines/${symbol}/1m`, why: "returns, excursions, and taker flow" },
  /*
   * Positioning, which nothing in this project has ever looked at.
   *
   * `metrics` carries open interest and three separate long/short ratios —
   * accounts, positions, and top traders. Where the book says what is resting
   * right now, these say who is already committed and how leveraged they are,
   * which is a different question and the one a squeeze is actually about. The
   * search that ran without them scored fourteen features of which eleven were
   * restatements of the same depth reading.
   */
  { kind: "metrics", subpath: `metrics/${symbol}`, why: "open interest and long/short positioning" },
  /*
   * Funding and basis: the only genuinely structural edge a perpetual has.
   *
   * A perp is pinned to spot by a payment that changes hands every eight hours.
   * That is a carry, it is observable in advance, and harvesting it needs no
   * directional opinion at all — which matters enormously here, because 513,000
   * samples just said this market has no predictable direction at these
   * horizons and does have a predictable step size.
   */
  { kind: "premiumIndexKlines", subpath: `premiumIndexKlines/${symbol}/1m`, why: "basis against spot; funding carry" },
  /*
   * Ticks, because the mechanism claims to work in seconds.
   *
   * The first replay tested a seconds-scale hypothesis on one-minute bars,
   * which is how such an effect disappears. Large and optional — it is roughly
   * a gigabyte a month — so it is fetched last and its absence is not fatal.
   */
  { kind: "aggTrades", subpath: `aggTrades/${symbol}`, why: "tick tape; sub-minute mechanics" },
];

/** Skipped unless asked for: it is orders of magnitude larger than the rest. */
const HEAVY = new Set(["aggTrades"]);

async function main() {
  const dates = dateRange();
  console.error("");
  console.error(`[history] ${symbol} · ${dates[0]} to ${dates[dates.length - 1]} · ${dates.length} days`);
  console.error(`[history] into ${outDir}`);
  console.error("[history] public archive, no API key, nothing here touches the trading path");
  console.error("");
  for (const k of KINDS) console.error(`[history]   ${k.kind}: ${k.why}`);
  console.error("");

  const results: Fetched[] = [];
  /*
   * Four at a time.
   *
   * Enough that a 700-day pull is not an afternoon, few enough that this cannot
   * look like an attack on a public endpoint. The archive is a courtesy and
   * hammering it is how it stops being one.
   */
  const wanted = process.argv.includes("--ticks") ? KINDS : KINDS.filter((k) => !HEAVY.has(k.kind));
  if (wanted.length < KINDS.length) {
    console.error("[history] skipping aggTrades — pass --ticks to include it (about 1 GB a month)");
    console.error("");
  }
  const queue = dates.flatMap((date) => wanted.map((k) => ({ date, ...k })));
  const CONCURRENCY = 4;
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const job = queue[cursor++];
      if (!job) return;
      const r = await grab(job.kind, job.date, job.subpath);
      results.push(r);
      done++;
      if (done % 25 === 0 || done === queue.length) {
        const mb = results.reduce((a, x) => a + x.bytes, 0) / 1e6;
        console.error(`[history] ${done}/${queue.length} · ${mb.toFixed(0)} MB`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const by = (s: Fetched["status"]) => results.filter((r) => r.status === s);
  console.error("");
  console.error(
    `[history] ${by("downloaded").length} downloaded · ${by("cached").length} already here · ` +
      `${by("missing").length} not published · ${by("failed").length} failed`,
  );

  /*
   * Name the failures, grouped.
   *
   * "12 failed" sends someone to read a log; "12 failed: HTTP 451" tells them
   * the archive is geoblocked where they are, which is a different problem with
   * a different fix.
   */
  const failures = by("failed");
  if (failures.length) {
    const reasons = new Map<string, number>();
    for (const f of failures) reasons.set(f.detail ?? "?", (reasons.get(f.detail ?? "?") ?? 0) + 1);
    for (const [why, n] of reasons) console.error(`[history]   ${n}× ${why}`);
  }

  /*
   * A missing kind is worth saying loudly rather than leaving to be inferred
   * from a backtest with no signals in it.
   */
  for (const k of wanted) {
    const got = results.filter((r) => r.kind === k.kind && (r.status === "downloaded" || r.status === "cached"));
    if (got.length === 0) {
      console.error(`[history] !! nothing for ${k.kind} — the replay cannot run without it`);
    }
  }

  const manifest = {
    at: Date.now(),
    symbol,
    dates,
    kinds: wanted.map((k) => k.kind),
    files: results.map((r) => ({ kind: r.kind, date: r.date, bytes: r.bytes, status: r.status })),
    totalBytes: results.reduce((a, r) => a + r.bytes, 0),
  };
  const manifestPath = resolve(outDir, `manifest-${symbol}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[history] manifest: ${manifestPath}`);
  console.error(`[history] next:     npm run sweep:backtest`);
  console.error("");
}

/* Unzipping is left to the replay, which streams rather than expanding to disk. */
void createWriteStream;
void readFileSync;
void execFileSync;

main().catch((err) => {
  console.error(`[history] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
