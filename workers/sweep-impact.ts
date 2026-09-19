/**
 * How far a real order walks the book, which is the cost the spread is not.
 *
 * The tick measurement settled the spread: one tick on both contracts, 0.243bp
 * on LITUSDT and 0.01bp on BTCUSDT, each landing exactly on its own tick size.
 * That was the number the cost bar had been built on, inflated ten- to
 * twentyfold by minute-resolution estimators reading mean reversion as bounce.
 *
 * It also made the spread irrelevant. A quarter of a basis point does not
 * threaten a 16bp finding. What threatens it is that the finding is a *decile* —
 * a tenth of the sample — and the book that has to absorb it is one tick wide
 * and thin. The binding cost is walking that book, not crossing it, and nothing
 * in this project has ever measured that.
 *
 * ## The curve is already in the archive
 *
 * `bookDepth` publishes notional resting within each of several percentage
 * bands of mid, once a minute, per side. The replay reads the 1% band and
 * discards the rest. The discarded rows are a depth curve: how much size sits
 * within 1%, 2%, 3%, 5% and so on.
 *
 * Given an order of some notional, the curve says which band it exhausts. The
 * average fill lands somewhere between the touch and that band's edge, so
 * interpolating across the curve gives the distance travelled — impact, in the
 * same basis points the findings are quoted in.
 *
 * ## Why several sizes rather than one
 *
 * The order size is a risk decision the operator owns, and picking one here
 * would hide the shape of the answer behind a guess. Impact is strongly
 * non-linear in size: it is nothing until the order approaches the resting
 * depth and then it is everything. Reporting a ladder shows where that knee
 * sits, which is the actionable fact — a finding worth 16bp is tradeable at
 * whatever size keeps impact well under it, and that size is the deliverable,
 * not a yes or no.
 *
 * ## What it still does not model
 *
 * Resting depth is not the same as available depth: quotes are pulled as an
 * order arrives, and a book that shows size at 1% will not necessarily fill
 * there. This is therefore optimistic, and it is the optimistic case that
 * matters — if a finding does not survive a generous impact model it certainly
 * does not survive a real one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";
import { SYMBOL } from "../lib/sweep/config";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const symbol = arg("symbol", process.env.SWEEP_SYMBOL?.trim() || SYMBOL).toUpperCase();
const inDir = resolve(arg("in", "data/history"));
const outPath = resolve(arg("out", `evidence/impact-${symbol}.json`));

/** Order sizes to price, in USD notional. */
const SIZES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

/** One minute's depth curve: percentage band -> notional resting inside it. */
type Curve = Map<number, { bid: number; ask: number }>;

function load(): Curve[] {
  /*
   * The same layout question the replay had to answer. Files moved under
   * `<symbol>/<kind>/` after two instruments were once mixed into one series,
   * and an empty new-layout directory sitting beside a populated old one
   * refused every run for days. So the test is whether a directory holds this
   * symbol's files, not whether it exists.
   */
  const candidates = [join(inDir, symbol, "bookDepth"), join(inDir, "bookDepth")];
  let dir: string | null = null;
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (readdirSync(c).some((f) => f.endsWith(".zip") && f.startsWith(`${symbol}-`))) {
      dir = c;
      break;
    }
  }
  if (!dir) {
    console.error(`[impact] no bookDepth for ${symbol} under ${inDir} — run sweep:history first`);
    process.exit(1);
  }

  const byMinute = new Map<number, Curve>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".zip") && f.startsWith(`${symbol}-`))
    .sort();
  for (const f of files) {
    for (const entry of unzipEntries(readFileSync(join(dir, f)))) {
      for (const r of csvRows(entry.data)) {
        // timestamp,percentage,depth,notional
        if (r.length < 4) continue;
        /*
         * parseTs, not Number.
         *
         * The archive writes bookDepth timestamps as text dates, and some
         * feeds use microseconds. Number("2026-09-15 00:00:00") is NaN, so
         * every row was skipped and the worker reported "30 file(s), 0
         * minutes" — found the data, parsed none of it. The helper exists for
         * exactly this and the replay has always used it; this did not.
         */
        const ts = parseTs(r[0] ?? "");
        const pct = Number(r[1]);
        const notional = Number(r[3]);
        if (!Number.isFinite(ts) || !Number.isFinite(pct) || !Number.isFinite(notional)) continue;
        if (pct === 0) continue;
        const slot = Math.floor(ts / 60_000) * 60_000;
        let curve = byMinute.get(slot);
        if (!curve) {
          curve = new Map();
          byMinute.set(slot, curve);
        }
        const band = Math.abs(pct);
        const cur = curve.get(band) ?? { bid: 0, ask: 0 };
        if (pct < 0) cur.bid += notional;
        else cur.ask += notional;
        curve.set(band, cur);
      }
    }
  }
  console.error(`[impact] ${files.length} file(s), ${byMinute.size.toLocaleString()} minutes`);
  return [...byMinute.values()];
}

/**
 * How far an order of `usd` walks one side, in basis points.
 *
 * The curve is cumulative by construction — notional within 2% includes
 * everything within 1% — so the band that first covers the order is where it
 * finishes. The average fill is modelled as the midpoint between the previous
 * band's edge and that one's, which is the standard linear-book approximation
 * and errs optimistic on a book that thins with distance.
 *
 * Null when the order exceeds every published band: the honest answer there is
 * that the archive cannot say, not some extrapolated number. A finding whose
 * size runs off the end of the curve has not been shown to be tradeable.
 */
function impactBps(curve: Curve, usd: number, side: "bid" | "ask"): number | null {
  const bands = [...curve.keys()].sort((a, b) => a - b);
  let prevEdge = 0;
  let prevNotional = 0;
  for (const band of bands) {
    const available = curve.get(band)![side];
    if (available >= usd) {
      // Where inside this band the order finishes, then the average fill.
      const need = usd - prevNotional;
      const inBand = available - prevNotional;
      const frac = inBand > 0 ? Math.min(1, need / inBand) : 1;
      const finish = prevEdge + (band - prevEdge) * frac;
      return ((prevEdge + finish) / 2) * 100;
    }
    prevEdge = band;
    prevNotional = available;
  }
  return null;
}

function main() {
  const curves = load();
  if (curves.length === 0) {
    console.error("[impact] no minutes parsed — the files are present but empty");
    process.exit(1);
  }

  const bands = [...new Set(curves.flatMap((c) => [...c.keys()]))].sort((a, b) => a - b);
  console.error(`[impact] bands published: ${bands.map((b) => `${b}%`).join(", ")}`);

  const rows = SIZES.map((usd) => {
    const vals: number[] = [];
    let offCurve = 0;
    for (const c of curves) {
      for (const side of ["bid", "ask"] as const) {
        const v = impactBps(c, usd, side);
        if (v === null) offCurve++;
        else vals.push(v);
      }
    }
    vals.sort((a, b) => a - b);
    const at = (q: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * q))] : null);
    return {
      usd,
      /* One-way. A round trip pays it twice. */
      medianBps: at(0.5),
      p75Bps: at(0.75),
      p90Bps: at(0.9),
      /*
       * Minutes where the order exceeded every published band. A high share
       * means the ladder has run past what the archive can answer, and the
       * median below it is computed on the minutes that happened to be deep —
       * which flatters it.
       */
      offCurveShare: offCurve / (curves.length * 2),
    };
  });

  const report = {
    at: Date.now(),
    symbol,
    minutes: curves.length,
    bandsPct: bands,
    sizes: rows,
    note:
      "One-way impact from resting depth; a round trip pays it twice. Optimistic by " +
      "construction — resting size is not available size, since quotes are pulled as an " +
      "order arrives. If a finding does not survive this it certainly does not survive " +
      "a real book.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`[impact] ${symbol}, one-way, median bps by size:`);
  for (const r of rows) {
    console.error(
      `  $${r.usd.toLocaleString().padStart(7)}  ` +
        `${r.medianBps === null ? "off curve" : r.medianBps.toFixed(2).padStart(6) + "bp"}` +
        `  p90 ${r.p90Bps === null ? "n/a" : r.p90Bps.toFixed(2) + "bp"}` +
        `  off-curve ${(r.offCurveShare * 100).toFixed(1)}%`,
    );
  }
  console.error(`[impact] -> ${outPath}`);
}

main();
