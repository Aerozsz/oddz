/**
 * What an order actually paid, taken from orders that actually happened.
 *
 * The sizing ladder rests on one assumption and the journal has named it as the
 * thing most likely to overturn the only number this project has worth arguing
 * with: `sweep-impact` prices an order against *resting* depth, and resting is
 * not available. Quotes are pulled as an order arrives. A book showing $25,000
 * within 1% does not fill $25,000 within 1%.
 *
 * That assumption has never been checked against anything, and it does not need
 * a live connection to check. The aggTrades archive is a record of orders that
 * really were executed, with size and with the side that crossed, so the price
 * they really moved can be read off directly.
 *
 * ## The measurement
 *
 * Consecutive prints with the same aggressor inside a short gap are one order
 * walking the book — a market order sweeping several levels prints once per
 * level, milliseconds apart, all with the same `isBuyerMaker`. Summing the
 * notional across that burst gives the size, and the distance from the price
 * before it to the price at its end gives what that size cost, in the basis
 * points the findings are quoted in.
 *
 * Bucketed by notional, that is an impact curve measured on executions rather
 * than modelled from quotes, and it can be laid beside the resting-depth curve
 * band for band.
 *
 * ## Temporary and permanent, which are different costs
 *
 * Displacement is measured twice: at the burst's last print, and again a minute
 * later. The first is what the order paid to get filled. The second is where
 * price settled — if it comes most of the way back, the order pushed the book
 * and the book recovered, and a round trip pays that push twice. If it does
 * not, the burst carried information and the move was not a cost at all.
 *
 * A round trip is charged on the temporary part, which is the part that
 * reverts. Reporting both is what makes it possible to tell them apart.
 *
 * ## What this is and is not
 *
 * It is not a clean estimate of what *our* order would pay, and nothing here
 * should pretend otherwise. These bursts are endogenous: a trader who sweeps
 * $50,000 usually has a reason, and part of the displacement is that reason
 * becoming public rather than the mechanical cost of consuming depth. So this
 * runs high, exactly as the resting-depth model runs low.
 *
 * That is the point of computing it. Two models that err in known and opposite
 * directions bracket the answer, and a sizing table quoted between them is
 * honest in a way that either alone is not.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { unzipEntries, csvRows } from "../lib/sweep/backtest/zip";
import { SYMBOL } from "../lib/sweep/config";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const symbol = arg("symbol", process.env.SWEEP_SYMBOL?.trim() || SYMBOL).toUpperCase();
const days = Math.max(1, Number(arg("days", "3")));
const outPath = resolve(arg("out", `evidence/realized-${symbol}.json`));
const BASE = "https://data.binance.vision/data/futures/um";

/** Prints this far apart are two orders, not one order walking the book. */
const BURST_GAP_MS = 250;
/** Where price settled, for telling a push that reverts from news that does not. */
const SETTLE_MS = 60_000;

/** The same ladder sweep-impact prices, so the two curves can be compared row for row. */
const BUCKETS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

interface Print {
  t: number;
  price: number;
  qty: number;
  buyerIsMaker: boolean;
}

async function fetchDay(date: string): Promise<Print[]> {
  const url = `${BASE}/daily/aggTrades/${symbol}/${symbol}-aggTrades-${date}.zip`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[realized] ${date}: HTTP ${res.status} — skipping`);
    return [];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out: Print[] = [];
  for (const entry of unzipEntries(buf)) {
    for (const row of csvRows(entry.data)) {
      // a,p,q,f,l,T,m — id, price, qty, firstId, lastId, time, isBuyerMaker
      if (row.length < 7) continue;
      const price = Number(row[1]);
      const qty = Number(row[2]);
      const t = Number(row[5]);
      if (!(price > 0) || !(qty > 0) || !Number.isFinite(t)) continue;
      out.push({ t, price, qty, buyerIsMaker: row[6].trim().toLowerCase() === "true" });
    }
  }
  return out;
}

interface Burst {
  /** True when the aggressor was a buyer, so the burst lifted the ask. */
  buy: boolean;
  usd: number;
  prints: number;
  /** Basis points travelled by the burst's end, signed toward the aggressor. */
  moveBps: number;
  /** The same, a minute after the burst ended. Null when the tape ends first. */
  settleBps: number | null;
}

/**
 * Bursts of one-sided aggression, with what each one moved.
 *
 * The reference price is the print *before* the burst began, not its own first
 * print: the first print of a sweep has already crossed the spread, so
 * measuring from it charges the sweep for everything except its first level and
 * understates a small burst by the whole spread.
 */
export function bursts(prints: Print[]): Burst[] {
  const out: Burst[] = [];
  let i = 0;
  while (i < prints.length) {
    const side = prints[i].buyerIsMaker;
    let j = i;
    let usd = 0;
    while (
      j < prints.length &&
      prints[j].buyerIsMaker === side &&
      (j === i || prints[j].t - prints[j - 1].t <= BURST_GAP_MS)
    ) {
      usd += prints[j].price * prints[j].qty;
      j++;
    }

    /*
     * Only bursts with a price before them. The first burst of a file has no
     * reference and gets dropped rather than measured against itself, which is
     * a handful of observations out of hundreds of thousands.
     */
    if (i > 0 && usd > 0) {
      const before = prints[i - 1].price;
      const end = prints[j - 1].price;
      /* isBuyerMaker true means the aggressor sold, so the sign flips. */
      const buy = !side;
      const dir = buy ? 1 : -1;
      const moveBps = (((end - before) / before) * 10_000) * dir;

      let settleBps: number | null = null;
      const target = prints[j - 1].t + SETTLE_MS;
      for (let k = j; k < prints.length; k++) {
        if (prints[k].t >= target) {
          settleBps = (((prints[k].price - before) / before) * 10_000) * dir;
          break;
        }
      }

      out.push({ buy, usd, prints: j - i, moveBps, settleBps });
    }
    i = j;
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/**
 * Bursts grouped into the ladder's size bands.
 *
 * A band holds the bursts whose notional is nearest it on a log scale, so
 * "$10,000" means bursts between about $7,000 and $16,000 rather than exactly
 * ten thousand — exact matches would leave every band empty. Bands with too few
 * bursts report null rather than a median of nine observations.
 */
export function curve(all: Burst[]) {
  return BUCKETS.map((usd, idx) => {
    const lo = idx === 0 ? 0 : Math.sqrt(usd * BUCKETS[idx - 1]);
    const hi = idx === BUCKETS.length - 1 ? Infinity : Math.sqrt(usd * BUCKETS[idx + 1]);
    const inBand = all.filter((b) => b.usd >= lo && b.usd < hi);
    const moves = inBand.map((b) => b.moveBps);
    const settled = inBand.filter((b) => b.settleBps !== null).map((b) => b.settleBps as number);

    /*
     * A hundred bursts, not ten. The whole point of this number is to argue
     * with a modelled curve, and a median over a handful of observations is not
     * in a position to argue with anything.
     */
    const enough = inBand.length >= 100;
    const move = enough ? median(moves) : null;
    const settle = enough ? median(settled) : null;

    return {
      usd,
      bursts: inBand.length,
      /** One-way, what the burst paid to get filled. */
      moveBps: move,
      p75Bps: enough ? quantile(moves, 0.75) : null,
      p90Bps: enough ? quantile(moves, 0.9) : null,
      /** Where price sat a minute later, from the same reference. */
      settleBps: settle,
      /*
       * The part that came back, which is the part a round trip pays. Null
       * rather than zero when it cannot be computed: a zero temporary impact is
       * a cost bar every finding clears, which is the expensive way to be wrong.
       */
      temporaryBps: move !== null && settle !== null ? Math.max(0, move - settle) : null,
    };
  });
}

async function main() {
  const dates: string[] = [];
  for (let d = 2; d < 2 + days; d++) {
    dates.push(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
  }
  console.error(`[realized] ${symbol} · ${dates.join(", ")}`);

  const prints: Print[] = [];
  for (const date of dates) {
    const day = await fetchDay(date);
    console.error(`[realized] ${date}: ${day.length.toLocaleString()} prints`);
    // A loop, never `prints.push(...day)` — a day of aggTrades is hundreds of
    // thousands of prints and spreading it throws RangeError. Twice already.
    for (const p of day) prints.push(p);
  }

  if (prints.length === 0) {
    console.error("[realized] no prints — the archive published nothing for these dates");
    process.exit(1);
  }

  prints.sort((a, b) => a.t - b.t);
  const all = bursts(prints);
  const rows = curve(all);

  const report = {
    at: Date.now(),
    symbol,
    days,
    dates,
    prints: prints.length,
    bursts: all.length,
    burstGapMs: BURST_GAP_MS,
    settleMs: SETTLE_MS,
    sizes: rows,
    note:
      "Impact measured on executed sweeps rather than modelled from resting depth. Runs HIGH by " +
      "construction: these bursts are endogenous, so part of what they moved is their own " +
      "information becoming public rather than the mechanical cost of consuming depth. The " +
      "resting-depth curve in impact-<symbol>.json runs low for the opposite reason. The honest " +
      "cost sits between them, and a sizing table that survives both ends is one worth acting on. " +
      "temporaryBps is the part that reverted within a minute and is what a round trip pays.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`[realized] ${all.length.toLocaleString()} bursts, one-way bps by size:`);
  for (const r of rows) {
    console.error(
      `  $${r.usd.toLocaleString().padStart(7)}  n=${String(r.bursts).padStart(7)}  ` +
        `move ${r.moveBps === null ? "  n/a" : r.moveBps.toFixed(2).padStart(6)}bp  ` +
        `settle ${r.settleBps === null ? "  n/a" : r.settleBps.toFixed(2).padStart(6)}bp  ` +
        `temporary ${r.temporaryBps === null ? "n/a" : r.temporaryBps.toFixed(2) + "bp"}`,
    );
  }
  console.error(`[realized] -> ${outPath}`);
}

if (process.argv[1] && process.argv[1].includes("sweep-realized")) void main();
