/**
 * Score the entry hypothesis against years, and write the answer where it can
 * be read from off the machine.
 *
 *   npm run sweep:backtest                       # whatever sweep:history fetched
 *   npm run sweep:backtest -- --symbol BTCUSDT
 *
 * ## The question
 *
 * The strategy's premise is one sentence: when the depth on the side price would
 * have to travel through is below its own recent baseline, price is more likely
 * to travel that way. Everything else — the cluster map, the cascade model, the
 * hold engine, the fee accounting — is downstream of that being true.
 *
 * It has never been measured. `DEAD_ZONE = 0.12` in bias.ts is the threshold the
 * premise is traded on, and it was chosen rather than fitted. Twenty-eight live
 * trades cannot move it; four hundred thousand minutes can.
 *
 * ## What this is, precisely
 *
 * Not a simulation of the agent. Deliberately not — a full replay would carry
 * the sizer, the hold engine, the burst guard and the fee model, and every one
 * of those is a place for a bug to manufacture an edge that is not there. This
 * measures the signal and nothing else: at each minute, compute the depth
 * asymmetry, then look at what price did over the next hour. If the buckets do
 * not separate, no exit rule and no fee saving can rescue it, and that is worth
 * knowing before another line of either is written.
 *
 * ## The one honest caveat, stated up front
 *
 * `bookDepth` is a one-minute snapshot of notional resting within 1% of mid.
 * The live tracker reads the full book continuously and can see depth *pulled*
 * as distinct from depth *traded through*. This cannot: it sees the level, not
 * the mechanism. So a null result here is strong — if the level does not predict
 * over any horizon, the finer measurement is unlikely to rescue it — while a
 * positive result is a floor rather than a ceiling.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const symbol = arg("symbol", "BTCUSDT").toUpperCase();
const histDir = resolve(arg("in", "data/history"));
const outPath = resolve(arg("out", `evidence/backtest-${symbol}.json`));

/** Matches the live tracker's half-life, so the ratio means the same thing. */
const BASELINE_HALF_LIFE_MIN = 30;
/** Minutes of baseline before a reading is used at all. */
const WARMUP_MIN = 60;
/** Horizons in minutes, scored forward from each snapshot. */
const HORIZONS = [1, 5, 15, 30, 60];

/* ------------------------------------------------------------------ input */

interface Minute {
  ts: number;
  bid1: number;
  ask1: number;
}

/** Notional within 1% of mid, per side, per minute. */
function readBookDepth(dir: string): Minute[] {
  if (!existsSync(dir)) return [];
  const byTs = new Map<number, { bid: number; ask: number }>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".zip")).sort()) {
    let entries;
    try {
      entries = unzipEntries(readFileSync(join(dir, file)));
    } catch (err) {
      console.error(`[backtest] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const e of entries) {
      for (const row of csvRows(e.data)) {
        // timestamp,percentage,depth,notional
        const ts = parseTs(row[0] ?? "");
        const pct = Number(row[1]);
        const notional = Number(row[3]);
        if (!Number.isFinite(ts) || !Number.isFinite(pct) || !Number.isFinite(notional)) continue;
        /*
         * The 1% band only.
         *
         * The wider bands are dominated by resting size nobody intends to
         * defend, and the entry rule is about the depth immediately in front of
         * price. Using ±1% keeps this comparable to the live primary band.
         */
        if (Math.abs(pct) !== 1) continue;
        const slot = byTs.get(ts) ?? { bid: 0, ask: 0 };
        if (pct < 0) slot.bid += notional;
        else slot.ask += notional;
        byTs.set(ts, slot);
      }
    }
  }
  return [...byTs.entries()]
    .map(([ts, v]) => ({ ts, bid1: v.bid, ask1: v.ask }))
    .sort((a, b) => a.ts - b.ts);
}

interface Bar {
  ts: number;
  close: number;
  high: number;
  low: number;
}

function readKlines(dir: string): Map<number, Bar> {
  const out = new Map<number, Bar>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".zip")).sort()) {
    let entries;
    try {
      entries = unzipEntries(readFileSync(join(dir, file)));
    } catch (err) {
      console.error(`[backtest] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const e of entries) {
      for (const row of csvRows(e.data)) {
        // open_time,open,high,low,close,volume,close_time,...
        const ts = parseTs(row[0] ?? "");
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
        out.set(Math.floor(ts / 60_000) * 60_000, { ts, close, high, low });
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- buckets */

interface Bucket {
  label: string;
  n: number;
  /** Mean forward move in the signalled direction, in basis points. */
  meanBps: Record<string, number>;
  seBps: Record<string, number>;
  /** Share of snapshots where the move was favourable, per horizon. */
  hitRate: Record<string, number>;
}

function summarise(label: string, rows: { by: Record<string, number> }[]): Bucket {
  const meanBps: Record<string, number> = {};
  const seBps: Record<string, number> = {};
  const hitRate: Record<string, number> = {};
  for (const h of HORIZONS) {
    const key = `t${h}`;
    const xs = rows.map((r) => r.by[key]).filter((x) => Number.isFinite(x));
    const n = xs.length;
    const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
    const varr = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    meanBps[key] = mean;
    seBps[key] = n > 1 ? Math.sqrt(varr / n) : Infinity;
    hitRate[key] = n ? xs.filter((x) => x > 0).length / n : 0;
  }
  return { label, n: rows.length, meanBps, seBps, hitRate };
}

/* ------------------------------------------------------------------- main */

function main() {
  const minutes = readBookDepth(join(histDir, "bookDepth"));
  const bars = readKlines(join(histDir, "1m"));

  console.error("");
  console.error(`[backtest] ${symbol}`);
  console.error(`[backtest] ${minutes.length} depth snapshots · ${bars.size} price bars`);
  if (minutes.length === 0 || bars.size === 0) {
    console.error("[backtest] nothing to work with — run npm run sweep:history first");
    process.exit(1);
  }

  /*
   * The baseline, built the same way the live tracker builds it: an EWMA of the
   * side's own recent notional. The ratio against it — not the raw notional — is
   * what the entry rule reads, because absolute depth varies by an order of
   * magnitude between a Sunday night and an FOMC minute and would otherwise be
   * measuring the clock.
   */
  const alpha = 1 - Math.pow(0.5, 1 / BASELINE_HALF_LIFE_MIN);
  let bidBase = 0;
  let askBase = 0;
  let seen = 0;

  const rows: { signal: number; thin: number; by: Record<string, number> }[] = [];
  let skippedNoBar = 0;

  for (const m of minutes) {
    if (seen === 0) {
      bidBase = m.bid1;
      askBase = m.ask1;
    } else {
      bidBase += alpha * (m.bid1 - bidBase);
      askBase += alpha * (m.ask1 - askBase);
    }
    seen++;
    if (seen < WARMUP_MIN || !(bidBase > 0) || !(askBase > 0)) continue;

    const lwiBid = m.bid1 / bidBase;
    const lwiAsk = m.ask1 / askBase;

    /*
     * The same composite the live bias computes for this factor: which side is
     * thinner, scaled by how far below its own baseline the travel side sits.
     * Positive means up — the ask is the thin side and price should travel
     * through it.
     */
    const denom = lwiBid + lwiAsk;
    if (!(denom > 0)) continue;
    const asymmetry = (lwiBid - lwiAsk) / denom;
    const travelSide = asymmetry > 0 ? lwiAsk : lwiBid;
    const thin = Math.max(0, Math.min(1, (1 - travelSide) / 0.3));
    const signal = asymmetry * thin;
    if (signal === 0) continue;

    const slot = Math.floor(m.ts / 60_000) * 60_000;
    const entry = bars.get(slot);
    if (!entry) {
      skippedNoBar++;
      continue;
    }

    const by: Record<string, number> = {};
    let usable = false;
    for (const h of HORIZONS) {
      const later = bars.get(slot + h * 60_000);
      if (!later) continue;
      const raw = ((later.close - entry.close) / entry.close) * 10_000;
      // Signed so that positive is a win for the side the signal called.
      by[`t${h}`] = signal > 0 ? raw : -raw;
      usable = true;
    }
    if (usable) rows.push({ signal, thin: travelSide, by });
  }

  console.error(`[backtest] ${rows.length} scored snapshots · ${skippedNoBar} with no matching bar`);
  if (rows.length === 0) {
    console.error("[backtest] the depth and price files do not overlap in time — check the manifest dates");
    process.exit(1);
  }

  /*
   * Bands on the signal's magnitude, straddling the live threshold.
   *
   * 0.12 is DEAD_ZONE: everything below it is refused in production. If the
   * bands below 0.12 predict as well as the bands above it, the threshold is
   * discarding trades for nothing. If nothing predicts anywhere, the premise is
   * wrong and no threshold saves it. Both answers are actionable and neither is
   * available from live trading at twenty-eight samples.
   */
  const bands: [string, (s: number) => boolean][] = [
    ["|signal| 0.00-0.06 (refused today)", (s) => s < 0.06],
    ["|signal| 0.06-0.12 (refused today)", (s) => s >= 0.06 && s < 0.12],
    ["|signal| 0.12-0.25 (traded today)", (s) => s >= 0.12 && s < 0.25],
    ["|signal| 0.25-0.50 (traded today)", (s) => s >= 0.25 && s < 0.5],
    ["|signal| >=0.50 (traded today)", (s) => s >= 0.5],
  ];
  const bySignal = bands.map(([label, test]) => summarise(label, rows.filter((r) => test(Math.abs(r.signal)))));

  const depthBands: [string, (x: number) => boolean][] = [
    ["travel side <0.70x", (x) => x < 0.7],
    ["travel side 0.70-0.85x", (x) => x >= 0.7 && x < 0.85],
    ["travel side 0.85-1.00x", (x) => x >= 0.85 && x < 1],
    ["travel side >=1.00x", (x) => x >= 1],
  ];
  const byDepth = depthBands.map(([label, test]) => summarise(label, rows.filter((r) => test(r.thin))));

  const report = {
    at: Date.now(),
    symbol,
    method:
      "bookDepth 1% band vs a 30-minute EWMA of itself; signal = depth asymmetry scaled by how far " +
      "below baseline the travel side sits; forward close-to-close returns signed by the called side. " +
      "The signal only — no sizer, no hold engine, no fees.",
    caveat:
      "bookDepth is a 1-minute snapshot of resting notional and cannot separate depth pulled from " +
      "depth traded through. A null result here is therefore strong and a positive one is a floor.",
    snapshots: minutes.length,
    scored: rows.length,
    spanDays: Math.round((minutes[minutes.length - 1].ts - minutes[0].ts) / 86_400_000),
    horizons: HORIZONS,
    overall: summarise("all", rows),
    bySignal,
    byDepth,
  };

  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error("");
  console.error(`[backtest] span ${report.spanDays} days`);
  console.error("");
  console.error("  signal band                              n      15m bps     ±se    hit%");
  for (const b of bySignal) {
    console.error(
      `  ${b.label.padEnd(38)} ${String(b.n).padStart(7)}  ${b.meanBps.t15.toFixed(2).padStart(9)}  ` +
        `${b.seBps.t15.toFixed(2).padStart(6)}  ${(b.hitRate.t15 * 100).toFixed(1).padStart(5)}`,
    );
  }
  console.error("");
  console.error(`[backtest] written to ${outPath}`);
  console.error("[backtest] commit evidence/ and it travels with the next snapshot push");
  console.error("");
}

main();
