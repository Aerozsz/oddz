/**
 * Whether resting on the book escapes the cost, or only renames it.
 *
 * Every basis point of cost this project has measured is the cost of crossing.
 * Impact is what an aggressor pays to consume depth — 12.86bp of the 20.34bp
 * that killed $10,000 — and a resting order consumes none of it. That makes the
 * maker route the one path to the goal the measurements have not closed, and the
 * reason it is open is that it has never been tested rather than that it looks
 * promising.
 *
 * It cannot be tested on the live agent, which has not run since August, and
 * the thirty decisions in the snapshot that read `markoutWarm: false` predate
 * the fix that would change them. So it is tested here, against the tape.
 *
 * ## How a passive fill is decided
 *
 * Post at the touch on the signal's side when it fires. A later print that
 * trades at or through that price, from the opposite aggressor, would have taken
 * the order: a resting bid is filled by a seller hitting it.
 *
 * Queue position is the approximation and it is the honest limit of this. The
 * archive does not say who was already resting at that price, so a print that
 * merely *touches* the level might have filled someone else instead. Two
 * readings are therefore reported: the optimistic one, where touching fills, and
 * a strict one requiring the print to trade strictly *through* the level, which
 * means the queue at that price was exhausted and anyone resting there filled.
 *
 * Even the strict reading flatters, and by an unknown amount, which is why it is
 * not left as a caveat in prose. An order joining a queue is behind whatever was
 * already there, so it fills only once the aggressive volume arriving at that
 * level exceeds what sat in front of it. That quantity is not in the archive —
 * but the aggressive volume is, exactly, print by print. So the fill is also
 * computed against an assumed queue ahead, at several sizes, and the fill rate
 * and return are reported for each. A result that holds only at a queue of zero
 * is a result about being first in line every time, which nobody is.
 *
 * ## Why the fill rate is only half the question
 *
 * A passive order fills because price came to it. So fills are not a random
 * sample of signals — they concentrate precisely where the move went against the
 * entry, which is adverse selection and is the mechanism that kills naive
 * market-making. A 90% fill rate with all the fills on the wrong side is worse
 * than a 20% fill rate.
 *
 * So this reports the fill rate, and then the return *conditional on having
 * filled*, measured from the resting price rather than from the touch. That
 * second number is the one that decides whether the route survives. The signal
 * is `takerRatioFade` — fade lopsided taker flow — reconstructed here from the
 * same tape rather than imported, so this worker needs one file and no join.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";
import { SYMBOL } from "../lib/sweep/config";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const symbol = arg("symbol", process.env.SWEEP_SYMBOL?.trim() || SYMBOL).toUpperCase();
const days = Math.max(1, Number(arg("days", "3")));
const outPath = resolve(arg("out", `evidence/maker-${symbol}.json`));
const histRoot = resolve(arg("in", "data/history"));
const BASE = "https://data.binance.vision/data/futures/um";

/** The finding's horizon: five minutes from the decision bar. */
const HOLD_MS = 300_000;
/** How long the order rests before the chance is gone. */
const RESTS_MS = 300_000;
/** The decile that fires, on the per-minute taker ratio. */
const DECILE = 0.1;

/**
 * Queues to sit behind, as multiples of the order's own notional.
 *
 * Zero is the strict reading: the level cleared and we were somewhere in it.
 * The rest ask what happens if others were there first. The order is modelled
 * at $10,000, the size the ladder points at, so a queue of 5 is $50,000 of
 * resting size ahead — plausible at the touch on a contract whose 0.2% band
 * holds low hundreds of thousands.
 */
const ORDER_USD = 10_000;
const QUEUES = [0, 1, 5, 20];

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
    console.error(`[maker] ${date}: HTTP ${res.status} — skipping`);
    return [];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out: Print[] = [];
  for (const entry of unzipEntries(buf)) {
    for (const row of csvRows(entry.data)) {
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

interface Minute {
  ts: number;
  /** `-(takerRatio - 1)` on the venue's published ratio: the replay's feature. */
  fade: number;
  /** Last print of the minute — the decision price. */
  close: number;
  /** Index of the first print after this minute. */
  next: number;
}

/**
 * The venue's taker buy/sell volume ratio, per minute, forward-filled.
 *
 * Read from the same `metrics` files the replay reads, on disk rather than over
 * HTTP, because `sweep:history` has already downloaded them and column seven is
 * `sum_taker_long_short_vol_ratio`. Forward-fill only: a row stamped 12:05 was
 * not knowable at 12:03, and filling backwards hands the simulation information
 * the live agent could not have had — the easiest way there is to manufacture an
 * edge that evaporates in production.
 */
export function takerRatio(dir: string): Map<number, number> {
  const out = new Map<number, number>();
  const candidates = [join(dir, symbol, "metrics"), join(dir, "metrics")];
  let from: string | null = null;
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (readdirSync(c).some((f) => f.endsWith(".zip") && f.startsWith(`${symbol}-`))) {
      from = c;
      break;
    }
  }
  if (!from) return out;
  const raw: [number, number][] = [];
  for (const f of readdirSync(from).filter((x) => x.endsWith(".zip") && x.startsWith(`${symbol}-`)).sort()) {
    for (const e of unzipEntries(readFileSync(join(from, f)))) {
      for (const r of csvRows(e.data)) {
        const ts = parseTs(r[0] ?? "");
        const ratio = Number(r[7]);
        if (!Number.isFinite(ts) || !(ratio > 0)) continue;
        raw.push([Math.floor(ts / 60_000) * 60_000, ratio]);
      }
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  for (const [ts, ratio] of raw) out.set(ts, ratio);
  return out;
}

/**
 * Minutes carrying the feature, the decision price, and where the tape resumes.
 *
 * The metrics grid is five-minute, so each value is carried forward across the
 * minutes after it and a minute before the first published row has no feature
 * and is dropped rather than guessed.
 */
export function minutes(prints: Print[], ratios: Map<number, number>): Minute[] {
  const close = new Map<number, number>();
  const next = new Map<number, number>();
  for (let i = 0; i < prints.length; i++) {
    const m = Math.floor(prints[i].t / 60_000) * 60_000;
    close.set(m, prints[i].price);
    next.set(m, i + 1);
  }
  const slots = [...close.keys()].sort((a, b) => a - b);
  const out: Minute[] = [];
  let carried: number | null = null;
  for (const ts of slots) {
    const fresh = ratios.get(ts);
    if (fresh !== undefined) carried = fresh;
    if (carried === null) continue;
    out.push({
      ts,
      /* The replay's definition, sign and all. */
      fade: -(carried - 1),
      close: close.get(ts) as number,
      next: next.get(ts) as number,
    });
  }
  return out;
}

export interface Attempt {
  ts: number;
  /** True when the signal wants to be long, so the order rests on the bid. */
  long: boolean;
  /** Where the order rested. */
  restPrice: number;
  /** Filled under the loose rule: a print reached the level. */
  touched: boolean;
  /** Filled under the strict rule: a print traded through it. */
  through: boolean;
  /**
   * Aggressive notional that arrived at or through the level before the rest
   * expired. An order behind a queue of Q dollars fills only if this exceeds Q.
   */
  volumeAtLevel: number;
  /** Return by assumed queue ahead, in the order of QUEUES. Null when unfilled. */
  queuedRetBps: (number | null)[];
  /**
   * Return from the resting price to the end of the hold, signed to the
   * position, in bps. Null when unfilled — an unfilled order earns nothing and
   * must not be averaged in as a zero, which would flatter the result by
   * diluting the losses with non-trades.
   */
  retBps: number | null;
  strictRetBps: number | null;
  /** The same for a crossing entry, as the comparison that matters. */
  takerRetBps: number | null;
}

/**
 * One passive attempt per extreme-flow minute, on the side the data says.
 *
 * The side FOLLOWS the flow. The replay's deciles put heaviest taker buying at
 * +8.57bp over five minutes and heaviest selling at −7.13bp, each past ten
 * sigma — so a minute of overwhelming buying is a minute to be long, and resting
 * to go long means bidding below the market. The first version of this worker
 * shorted those minutes, which is exactly backwards, and measured a deliberately
 * wrong-way trade.
 *
 * Bucket 0 of the ranking is the lowest `takerRatioFade`, which is the highest
 * taker ratio, which is the heaviest buying. That chain is short and every link
 * inverts something, so it is written out here rather than left to be
 * re-derived.
 */
export function attempts(prints: Print[], ms: Minute[]): Attempt[] {
  if (ms.length < 100) return [];
  const sorted = ms.map((m) => m.fade).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * DECILE)];
  const hi = sorted[Math.floor(sorted.length * (1 - DECILE))];

  /*
   * A decile boundary that lands on a tied value swallows every minute holding
   * it, so "the extreme tenth" quietly becomes half the sample and the sides get
   * assigned by which comparison happened to be written first. Continuous data
   * does not do this; coarse data does, and a worker that cannot tell the two
   * apart will report a number about the wrong minutes.
   *
   * So the selection is checked against what it claims to be. Two deciles is
   * 20% of minutes, and anything past double that is not a decile.
   */
  const picked = ms.filter((m) => m.fade <= lo || m.fade >= hi);
  if (picked.length > ms.length * 0.4) {
    console.error(
      `[maker] the feature is too coarse to decile — ${picked.length} of ${ms.length} minutes ` +
        `land on the boundary (lo ${lo.toFixed(3)}, hi ${hi.toFixed(3)}). Refusing rather than ` +
        `reporting a number about the wrong minutes.`,
    );
    return [];
  }

  const out: Attempt[] = [];
  for (const m of ms) {
    if (m.fade > lo && m.fade < hi) continue;
    /*
     * Lowest fade value = highest taker ratio = heaviest buying = go long, and
     * rest on the bid. Following the flow, not fading it.
     */
    const long = m.fade <= lo;
    const restPrice = m.close;

    let touched = false;
    let through = false;
    let fillT: number | null = null;
    let strictFillT: number | null = null;
    let volumeAtLevel = 0;
    /* When the cumulative volume first passes each queue size. */
    const queuedFillT: (number | null)[] = QUEUES.map(() => null);
    const deadline = m.ts + 60_000 + RESTS_MS;

    for (let i = m.next; i < prints.length; i++) {
      const p = prints[i];
      if (p.t > deadline) break;
      /*
       * A resting bid is filled by an aggressive seller; a resting offer by an
       * aggressive buyer. The aggressor must be on the opposite side, which the
       * flag states, so this is not inferred.
       */
      const hitsUs = long ? p.buyerIsMaker : !p.buyerIsMaker;
      if (!hitsUs) continue;
      const reaches = long ? p.price <= restPrice : p.price >= restPrice;
      const beyond = long ? p.price < restPrice : p.price > restPrice;
      if (reaches && !touched) {
        touched = true;
        fillT = p.t;
      }
      if (beyond && !through) {
        through = true;
        strictFillT = p.t;
      }
      /*
       * Only volume that actually reached our price counts toward clearing the
       * queue in front of us. A print further away fills someone else.
       */
      if (reaches) {
        volumeAtLevel += p.price * p.qty;
        for (let q = 0; q < QUEUES.length; q++) {
          if (queuedFillT[q] === null && volumeAtLevel >= QUEUES[q] * ORDER_USD + ORDER_USD) {
            queuedFillT[q] = p.t;
          }
        }
      }
    }

    const dir = long ? 1 : -1;
    const priceAt = (from: number): number | null => {
      const target = from + HOLD_MS;
      for (let i = m.next; i < prints.length; i++) {
        if (prints[i].t >= target) return prints[i].price;
      }
      return null;
    };
    const ret = (fill: number | null): number | null => {
      if (fill === null) return null;
      const exit = priceAt(fill);
      if (exit === null) return null;
      return (((exit - restPrice) / restPrice) * 10_000) * dir;
    };

    /*
     * The crossing comparison is entered at the decision close, which is the
     * same price the passive order rests at. That is deliberate: it isolates
     * the effect of *waiting* from the effect of the entry price, and the entry
     * price advantage a maker gets is a separate quantity already measured as
     * the spread.
     */
    const takerExit = priceAt(m.ts + 60_000);
    const takerRetBps =
      takerExit === null ? null : (((takerExit - restPrice) / restPrice) * 10_000) * dir;

    out.push({
      ts: m.ts,
      long,
      restPrice,
      touched,
      through,
      volumeAtLevel,
      queuedRetBps: queuedFillT.map((t) => ret(t)),
      retBps: ret(fillT),
      strictRetBps: ret(strictFillT),
      takerRetBps,
    });
  }
  return out;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

const stderr = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v / xs.length);
};

const stat = (xs: number[]) => ({
  n: xs.length,
  meanBps: mean(xs),
  seBps: stderr(xs),
  sigma: (() => {
    const m = mean(xs);
    const s = stderr(xs);
    return m !== null && s !== null && s > 0 ? m / s : null;
  })(),
});

export function summarise(all: Attempt[]) {
  const filled = all.filter((a) => a.retBps !== null).map((a) => a.retBps as number);
  const strict = all.filter((a) => a.strictRetBps !== null).map((a) => a.strictRetBps as number);
  const taker = all.filter((a) => a.takerRetBps !== null).map((a) => a.takerRetBps as number);
  /*
   * The comparison that isolates adverse selection: how the crossing entry did
   * on the signals the passive order did NOT get filled on. If those are the
   * winners, the passive order is being handed the losers by construction.
   */
  const missed = all
    .filter((a) => !a.through && a.takerRetBps !== null)
    .map((a) => a.takerRetBps as number);


  /*
   * The sensitivity that decides how much the strict reading was flattering.
   * A queue of zero still requires our own size to trade at the level; each
   * step up asks the same question with more people in front.
   */
  const byQueue = QUEUES.map((q, i) => {
    const xs = all.filter((a) => a.queuedRetBps[i] !== null).map((a) => a.queuedRetBps[i] as number);
    return {
      queueAheadUsd: q * ORDER_USD,
      fillRate: all.length ? xs.length / all.length : null,
      ...stat(xs),
    };
  });

  return {
    attempts: all.length,
    orderUsd: ORDER_USD,
    byQueue,
    fillRateTouched: all.length ? all.filter((a) => a.touched).length / all.length : null,
    fillRateThrough: all.length ? all.filter((a) => a.through).length / all.length : null,
    /** Passive, loose fill rule. */
    passive: stat(filled),
    /** Passive, requiring the queue at that price to be cleared. */
    passiveStrict: stat(strict),
    /** Crossing, every signal. */
    taker: stat(taker),
    /** Crossing, only the signals a passive order would have missed. */
    takerOnMissed: stat(missed),
  };
}

async function main() {
  const dates: string[] = [];
  for (let d = 2; d < 2 + days; d++) {
    dates.push(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
  }
  console.error(`[maker] ${symbol} · ${dates.join(", ")}`);

  const prints: Print[] = [];
  for (const date of dates) {
    const day = await fetchDay(date);
    console.error(`[maker] ${date}: ${day.length.toLocaleString()} prints`);
    // A loop, never a spread — a day of aggTrades overflows the argument limit.
    for (const p of day) prints.push(p);
  }
  if (prints.length === 0) {
    console.error("[maker] no prints — the archive published nothing for these dates");
    process.exit(1);
  }
  prints.sort((a, b) => a.t - b.t);

  const ratios = takerRatio(histRoot);
  if (ratios.size === 0) {
    console.error(
      `[maker] no metrics for ${symbol} under ${histRoot} — the feature comes from the venue's ` +
        `published taker ratio, not from the tape. Run sweep:history first.`,
    );
    process.exit(1);
  }
  const ms = minutes(prints, ratios);
  console.error(`[maker] ${ratios.size.toLocaleString()} metric rows · ${ms.length.toLocaleString()} minutes with a feature`);
  const all = attempts(prints, ms);
  const summary = summarise(all);

  const report = {
    at: Date.now(),
    symbol,
    days,
    dates,
    prints: prints.length,
    minutes: ms.length,
    metricRows: ratios.size,
    holdMs: HOLD_MS,
    restsMs: RESTS_MS,
    decile: DECILE,
    ...summary,
    /*
     * Restated in the report so a reader does not have to know that `taker` is
     * doing double duty as the control.
     */
    control: {
      crossingMeanBps: summary.taker.meanBps,
      crossingSigma: summary.taker.sigma,
      expectation:
        "Should land near the replay's own decile-tail mean for this symbol and horizon " +
        "(LITUSDT t5d: +8.57bp; BTCUSDT t5d: +1.75bp). A disagreement — especially in sign — " +
        "means this worker is selecting different minutes than the replay, and the passive " +
        "numbers below describe a different signal.",
    },
    note:
      "Whether resting escapes the cost of crossing or only renames it. Fill is decided by a " +
      "later print from the opposite aggressor reaching the resting price; queue position cannot " +
      "be known from the archive, so the strict reading — a print trading THROUGH the level, which " +
      "means the queue there was cleared — is the one to plan on. Unfilled attempts are excluded " +
      "rather than scored as zero: an order that never filled earns nothing, and averaging " +
      "non-trades in dilutes the losses and flatters the result. takerOnMissed is the adverse " +
      "selection test: if crossing did well precisely on the signals a passive order missed, the " +
      "passive order is being handed the losers by construction.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  const f = (s: { n: number; meanBps: number | null; sigma: number | null }) =>
    `${s.meanBps === null ? "n/a" : s.meanBps.toFixed(2) + "bp"} ` +
    `(${s.sigma === null ? "n/a" : s.sigma.toFixed(1) + " sigma"}, n=${s.n.toLocaleString()})`;

  console.error(`[maker] ${all.length.toLocaleString()} attempts in extreme-flow minutes`);
  console.error(
    `[maker] filled: ${((summary.fillRateTouched ?? 0) * 100).toFixed(1)}% touched, ` +
      `${((summary.fillRateThrough ?? 0) * 100).toFixed(1)}% through`,
  );
  /*
   * The control, printed first because it decides whether anything below it
   * means anything.
   *
   * The crossing leg is the trade the replay scores. If it does not come out near
   * the replay's tail mean — +8.57bp on LITUSDT at t5d, +1.75bp on BTCUSDT — then
   * this worker is selecting different minutes than the replay does and its
   * passive number is about a different signal. That is not a hypothetical: the
   * first version reconstructed the feature from the tape and traded it on the
   * wrong side, and its crossing leg returning −0.43bp where the replay says 8.57
   * is the only reason either mistake was found.
   */
  const control = summary.taker.meanBps;
  console.error(
    `[maker] CONTROL crossing ${f(summary.taker)} — compare against the replay's tail mean for ` +
      `this symbol and horizon. If they disagree, stop here: the passive number is about a ` +
      `different signal.` + (control !== null && control <= 0 ? " THEY DISAGREE IN SIGN." : ""),
  );
  console.error(`[maker] passive          ${f(summary.passive)}`);
  for (const q of summary.byQueue) {
    console.error(
      `[maker]   behind $${q.queueAheadUsd.toLocaleString().padStart(7)}  ` +
        `${((q.fillRate ?? 0) * 100).toFixed(1).padStart(5)}% filled  ${f(q)}`,
    );
  }
  console.error(`[maker] passive (strict) ${f(summary.passiveStrict)}`);
  console.error(`[maker] crossing         ${f(summary.taker)}`);
  console.error(`[maker] crossing, missed ${f(summary.takerOnMissed)}`);
  console.error(`[maker] -> ${outPath}`);
}

if (process.argv[1] && process.argv[1].includes("sweep-maker")) void main();
