/**
 * What crossing the spread actually costs, measured on the tape.
 *
 * The replay's cost bar decides which findings are real, and on LITUSDT it
 * currently rests on one leg. Two estimators were built so neither would be
 * load-bearing alone: Roll (1984), reading the spread out of the negative
 * autocorrelation that bid-ask bounce induces, and the delayed-entry test,
 * reading it out of how much edge a one-bar delay removes. On BTCUSDT they ran
 * and agreed — 2.47bp and 1.70bp. On LITUSDT Roll returned null, because at
 * one-minute resolution momentum dominates the bounce and the estimator has no
 * real root, so the bar there is the delayed-entry number alone.
 *
 * That is the bar `takerRatioFade` clears, and it clears it by 4.4bp. The
 * contract whose cost is least corroborated is the only one where the finding
 * survives, which is not a position to trade from.
 *
 * ## Why ticks answer it and minutes do not
 *
 * Roll has to *infer* trade direction from the price path, which is why
 * momentum breaks it. The aggTrades archive does not: every print carries
 * `isBuyerMaker`, so the side that crossed is known rather than guessed.
 *
 * With direction known the spread needs no model at all. When consecutive
 * prints hit opposite sides of the book, the gap between them is the distance
 * from bid to ask — which is the spread, observed. Averaging that over a few
 * hundred thousand direction flips is a measurement, not an estimate, and it
 * fails for none of the reasons Roll fails.
 *
 * Roll is computed on the same ticks as a cross-check, because at tick
 * resolution bounce dominates and it is back inside its own assumptions. Two
 * numbers from one file, arrived at differently.
 *
 * ## What this deliberately does not do
 *
 * It does not model size. The spread is the cost of crossing for something
 * small; a decile of a thin book is not small, and the impact of actually
 * lifting it is a separate and larger question. This is a floor on the cost,
 * never the whole of it, and the report says so.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { unzipEntries, csvRows } from "../lib/sweep/backtest/zip";
import { minOf, maxOf } from "../lib/sweep/numeric";
import { SYMBOL } from "../lib/sweep/config";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const symbol = arg("symbol", process.env.SWEEP_SYMBOL?.trim() || SYMBOL).toUpperCase();
const days = Math.max(1, Number(arg("days", "3")));
const outPath = resolve(arg("out", `evidence/spread-${symbol}.json`));
const BASE = "https://data.binance.vision/data/futures/um";

interface Print {
  t: number;
  price: number;
  /** True when the buyer was the maker, so the aggressor was a seller. */
  buyerIsMaker: boolean;
}

async function fetchDay(date: string): Promise<Print[]> {
  const url = `${BASE}/daily/aggTrades/${symbol}/${symbol}-aggTrades-${date}.zip`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[spread] ${date}: HTTP ${res.status} — skipping`);
    return [];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out: Print[] = [];
  for (const entry of unzipEntries(buf)) {
    for (const row of csvRows(entry.data)) {
      // a,p,q,f,l,T,m — id, price, qty, firstId, lastId, time, isBuyerMaker
      if (row.length < 7) continue;
      const price = Number(row[1]);
      const t = Number(row[5]);
      if (!(price > 0) || !Number.isFinite(t)) continue;
      out.push({ t, price, buyerIsMaker: row[6].trim().toLowerCase() === "true" });
    }
  }
  return out;
}

/**
 * The spread, observed at direction flips.
 *
 * A print where the buyer was the maker was hit into the bid; one where the
 * buyer was the taker lifted the ask. Consecutive prints on opposite sides
 * therefore span bid to ask, and the gap between them is the spread.
 *
 * Two guards, both of which matter more than they look:
 *
 *  - only consecutive prints, and only within a short window. A flip either
 *    side of a two-minute gap spans whatever the market did in between, which
 *    is a price move and not a spread.
 *  - the median, not the mean. One print through a thin book produces a gap of
 *    many spreads, and a mean over a few hundred thousand observations is
 *    dragged by a handful of them. The median is the typical crossing cost,
 *    which is the quantity the bar wants.
 */
function flipSpreadBps(prints: Print[]): { bps: number | null; flips: number } {
  const gaps: number[] = [];
  for (let i = 1; i < prints.length; i++) {
    const a = prints[i - 1];
    const b = prints[i];
    if (a.buyerIsMaker === b.buyerIsMaker) continue;
    if (b.t - a.t > 2_000) continue;
    const mid = (a.price + b.price) / 2;
    if (!(mid > 0)) continue;
    gaps.push((Math.abs(b.price - a.price) / mid) * 10_000);
  }
  if (gaps.length < 1000) return { bps: null, flips: gaps.length };
  gaps.sort((x, y) => x - y);
  return { bps: gaps[Math.floor(gaps.length / 2)], flips: gaps.length };
}

/** Roll on the tick series, where bounce dominates and its assumptions hold. */
function rollTickBps(prints: Print[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < prints.length; i++) {
    const a = prints[i - 1];
    const b = prints[i];
    // Same guard: a gap is not a price change worth pairing.
    if (b.t - a.t > 2_000) {
      d.push(NaN);
      continue;
    }
    d.push(((b.price - a.price) / a.price) * 10_000);
  }
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  for (let i = 1; i < d.length; i++) {
    const x = d[i - 1];
    const y = d[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sx += x;
    sy += y;
    sxy += x * y;
  }
  if (n < 1000) return null;
  const cov = sxy / n - (sx / n) * (sy / n);
  // Null, never zero — a zero spread is a bar everything clears.
  if (cov >= 0) return null;
  return 2 * Math.sqrt(-cov);
}

async function main() {
  const dates: string[] = [];
  for (let d = 2; d < 2 + days; d++) {
    dates.push(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
  }
  console.error(`[spread] ${symbol} · ${dates.join(", ")}`);

  const prints: Print[] = [];
  for (const date of dates) {
    const day = await fetchDay(date);
    console.error(`[spread] ${date}: ${day.length.toLocaleString()} prints`);
    prints.push(...day);
  }

  if (prints.length === 0) {
    console.error("[spread] no prints — the archive published nothing for these dates");
    process.exit(1);
  }

  prints.sort((a, b) => a.t - b.t);
  const flip = flipSpreadBps(prints);
  const roll = rollTickBps(prints);
  const lo = minOf(prints.map((p) => p.price));
  const hi = maxOf(prints.map((p) => p.price));

  const report = {
    at: Date.now(),
    symbol,
    days,
    dates,
    prints: prints.length,
    /** The measurement: median gap at direction flips. */
    flipSpreadBps: flip.bps,
    flips: flip.flips,
    /** The cross-check: Roll on the same ticks. */
    rollTickBps: roll,
    priceLow: lo,
    priceHigh: hi,
    note:
      "Spread only — the cost of crossing for something small. It is a floor on the " +
      "round trip, not the whole of it: a decile of a thin book is not small, and the " +
      "impact of lifting it is a separate and larger question.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error(
    `[spread] ${symbol}: flips ${flip.bps === null ? "n/a" : flip.bps.toFixed(2) + "bp"} ` +
      `(${flip.flips.toLocaleString()} obs), roll ${roll === null ? "n/a" : roll.toFixed(2) + "bp"}`,
  );
  console.error(`[spread] -> ${outPath}`);
}

void main();
