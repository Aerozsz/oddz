/**
 * Market-neutral spread trading across correlated perpetuals.
 *
 *   npm run sweep:pairs                       # paper, prints what it would do
 *   SWEEP_PAIRS_ARM=1 npm run sweep:pairs     # live orders
 *
 * A separate process from sweep:control on purpose. The directional loop is the
 * one with a track record, however short, and the way to avoid regressing it is
 * not to touch it — this shares the market-data layer and nothing else. It has
 * its own limits, its own journal, its own heartbeat, and can be run or not
 * without the other noticing.
 *
 * What it trades: one leg short the contract that has run ahead of its peers,
 * one leg long the one that has lagged, beta-weighted so the market move
 * cancels. The bet is that the *relationship* holds, not that the market goes
 * anywhere. See lib/sweep/agent/pairs.ts for why that is a narrower claim than
 * "delta neutral" usually implies, and lib/sweep/exchange/pair-orders.ts for
 * the one failure this design fears most — half a pair, which is a naked
 * directional position at full gross size wearing a hedged trade's name.
 *
 * Paper by default. Not caution for its own sake: this is new code, the spread
 * exit lives in this process rather than on the exchange, and the honest thing
 * before leaving it alone for a weekend is a session of watching it decide.
 */

import { loadEnv } from "./load-env";
import { beat } from "./heartbeat";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getEngine } from "../lib/sweep/engine";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import { DislocationTracker } from "../lib/sweep/metrics/dislocation";
import { PAIR_THRESHOLDS, proposePair, shouldClosePair, type PairProposal } from "../lib/sweep/agent/pairs";
import { closePair, openPair } from "../lib/sweep/exchange/pair-orders";
import {
  fetchAccountRisk,
  fetchPosition,
  hasCredentials,
  loadConfig,
  redact,
  explainError,
} from "../lib/sweep/exchange/binance";
import { fetchMeta } from "../lib/sweep/binance/rest";
import { DEFAULT_FEES } from "../lib/sweep/metrics/fees";

loadEnv();

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error(`\n  This needs Node 22 or newer. You are on ${process.versions.node}.\n`);
  process.exit(1);
}

/**
 * The contracts to compare.
 *
 * Blue chips on purpose: the residual only means something when both legs are
 * deep enough that a divergence is information rather than one order. Three or
 * more, because with two the "peer group" is a single name and any news about
 * it reads as a divergence in the other.
 */
const SYMBOLS = (process.env.SWEEP_PAIR_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const ARMED = process.env.SWEEP_PAIRS_ARM === "1";
const RISK_PCT = Number(process.env.SWEEP_PAIR_RISK_PCT ?? 2);
const MAX_GROSS = Number(process.env.SWEEP_PAIR_MAX_GROSS ?? 0);
const MAX_HOLD_MIN = Number(process.env.SWEEP_PAIR_MAX_HOLD_MIN ?? 240);
const MAX_PER_DAY = Number(process.env.SWEEP_PAIR_MAX_PER_DAY ?? 12);
const JOURNAL = resolve(process.env.SWEEP_PAIR_JOURNAL ?? "data/sweep-pairs.json");
const EVAL_MS = 15_000;

const log = (...a: unknown[]) => {
  const text = a.map((x) => (typeof x === "string" ? redact(x) : JSON.stringify(x))).join(" ");
  console.log(`[pairs ${new Date().toLocaleTimeString()}]`, text);
};

/* -------------------------------------------------------------- open pair */

interface OpenPair {
  openedAt: number;
  entryZ: number;
  richSymbol: string;
  cheapSymbol: string;
  beta: number;
  grossNotionalUsd: number;
  /** Which contract the z-score is measured on, so the sign stays comparable. */
  measuredOn: string;
}

function readJournal(): OpenPair | null {
  if (!existsSync(JOURNAL)) return null;
  try {
    const j = JSON.parse(readFileSync(JOURNAL, "utf8")) as OpenPair | null;
    return j && typeof j.entryZ === "number" ? j : null;
  } catch {
    return null;
  }
}

function writeJournal(p: OpenPair | null) {
  mkdirSync(dirname(JOURNAL), { recursive: true });
  const tmp = `${JOURNAL}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`);
  renameSync(tmp, JOURNAL);
}

let open: OpenPair | null = null;
let tradesToday = 0;
let dayStamp = new Date().toISOString().slice(0, 10);
const feeds = new Map<string, SweepFeed>();
const dislocation = new DislocationTracker();
const precision = new Map<string, number>();

const midOf = (s: string) => feeds.get(s)?.getState().mid ?? null;

/* ------------------------------------------------------------------ cycle */

async function evaluate() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) {
    dayStamp = today;
    tradesToday = 0;
    log("new day — trade counter reset");
  }

  for (const s of SYMBOLS) {
    const mid = midOf(s);
    if (mid) dislocation.record(s, mid);
  }

  if (open) return manageOpen();
  return lookForEntry();
}

async function manageOpen() {
  if (!open) return;
  const read = dislocation.read(open.measuredOn);
  const held = Date.now() - open.openedAt;
  // A z that cannot be read is not a z of zero. Hold, and let the time limit
  // be the backstop rather than closing on an absent measurement.
  if (!read.warm) {
    log(`holding ${open.richSymbol}/${open.cheapSymbol} — spread unreadable, ${Math.round(held / 60_000)} min in`);
    if (MAX_HOLD_MIN > 0 && held < MAX_HOLD_MIN * 60_000) return;
  }

  const verdict = shouldClosePair(open.entryZ, read.warm ? read.z : open.entryZ, held, MAX_HOLD_MIN * 60_000);
  if (!verdict.close) {
    log(`holding ${open.richSymbol}/${open.cheapSymbol} — ${verdict.reason}, ${Math.round(held / 60_000)} min in`);
    return;
  }

  log(`CLOSING ${open.richSymbol}/${open.cheapSymbol}: ${verdict.reason}`);
  if (!ARMED) {
    open = null;
    writeJournal(null);
    return;
  }
  try {
    const result = await closePair(loadConfig(), [open.richSymbol, open.cheapSymbol]);
    log(result.detail);
    if (result.ok) {
      open = null;
      writeJournal(null);
    }
    // Not flat: the journal stays, so the next cycle tries again rather than
    // forgetting a position that is still on the books.
  } catch (err) {
    log(`close FAILED: ${explainError(redact(err instanceof Error ? err.message : String(err)))}`);
  }
}

async function lookForEntry() {
  if (MAX_PER_DAY > 0 && tradesToday >= MAX_PER_DAY) return;

  let equity = 0;
  if (hasCredentials()) {
    try {
      equity = (await fetchAccountRisk(loadConfig())).availableBalance;
    } catch {
      // Paper mode does not need it; armed mode will refuse below.
    }
  }
  if (!(equity > 0)) equity = Number(process.env.SWEEP_PAIR_ASSUME_EQUITY ?? 5000);

  /*
   * Score every contract, take the most stretched.
   *
   * The peer for the hedge is the single most correlated of the others rather
   * than the whole group: a basket hedge needs a basket order, and legging into
   * three contracts multiplies the half-a-pair risk by three for a hedge that
   * is only marginally better.
   */
  const candidates: { proposal: PairProposal; z: number }[] = [];
  for (const symbol of SYMBOLS) {
    const read = dislocation.read(symbol);
    if (!read.warm || !read.coupled) continue;

    let bestPeer: string | null = null;
    let bestBeta = 0;
    let bestCorr = 0;
    for (const peer of SYMBOLS) {
      if (peer === symbol) continue;
      const b = dislocation.beta(symbol, peer);
      if (b === null) continue;
      // The most correlated peer makes the tightest hedge; correlation with
      // that one specifically, not the group average the read carries.
      const pairCorr = Math.abs(b) > 0 ? read.correlation : 0;
      if (pairCorr > bestCorr) {
        bestCorr = pairCorr;
        bestPeer = peer;
        bestBeta = b;
      }
    }
    if (!bestPeer) continue;

    const priceA = midOf(symbol);
    const priceB = midOf(bestPeer);
    // Hedged: the volatility of what the pair carries, not of the raw gap.
    const spreadVol = dislocation.spreadVolPct(symbol, bestPeer, bestBeta);
    if (!priceA || !priceB || spreadVol === null) continue;

    const result = proposePair({
      symbol,
      peer: bestPeer,
      dislocation: read,
      beta: bestBeta,
      priceA,
      priceB,
      equity,
      riskFraction: RISK_PCT / 100,
      maxGrossNotionalUsd: MAX_GROSS > 0 ? MAX_GROSS : equity * 4,
      spreadVolPct: spreadVol,
      roundTripPctPerLeg: DEFAULT_FEES.tiers[0].takerRate * 2 * 100,
    });
    if (result.ok) candidates.push({ proposal: result, z: Math.abs(read.z) });
  }

  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.z - a.z);
  const { proposal } = candidates[0];

  log("");
  log(`SPREAD: short ${proposal.rich}, long ${proposal.cheap}`);
  for (const line of proposal.reasoning) log(`   ${line}`);
  for (const leg of proposal.legs) {
    log(`   ${leg.side.padEnd(5)} ${leg.symbol} ${leg.notionalUsd.toFixed(0)} notional at ${leg.price}`);
  }

  if (!ARMED) {
    log("   (paper — set SWEEP_PAIRS_ARM=1 to send this)");
    // Recorded so the paper run produces the same hold/close narrative a live
    // one would, which is the point of watching it for a session.
    open = journalFrom(proposal);
    writeJournal(open);
    tradesToday++;
    return;
  }

  if (!hasCredentials()) {
    log("   armed but no credentials — nothing sent");
    return;
  }

  const cfg = loadConfig();
  const qty = (leg: (typeof proposal.legs)[number]) =>
    (leg.notionalUsd / leg.price).toFixed(precision.get(leg.symbol) ?? 3);

  const [a, b] = proposal.legs;
  const result = await openPair(
    cfg,
    { symbol: a.symbol, side: a.side === "long" ? "BUY" : "SELL", quantity: qty(a) },
    { symbol: b.symbol, side: b.side === "long" ? "BUY" : "SELL", quantity: qty(b) },
  );
  log(`   ${result.detail}`);
  if (!result.ok) return;

  open = journalFrom(proposal);
  writeJournal(open);
  tradesToday++;
}

function journalFrom(p: PairProposal): OpenPair {
  return {
    openedAt: Date.now(),
    entryZ: p.z,
    richSymbol: p.rich,
    cheapSymbol: p.cheap,
    beta: p.beta,
    grossNotionalUsd: p.grossNotionalUsd,
    measuredOn: p.legs[0].symbol,
  };
}

/* ---------------------------------------------------------------- startup */

async function main() {
  console.log("");
  console.log("  Pair trading — market-neutral spreads");
  console.log(`  contracts:   ${SYMBOLS.join(", ")}`);
  console.log(`  mode:        ${ARMED ? (hasCredentials() ? "ARMED — real orders" : "armed but no credentials") : "paper"}`);
  console.log(`  risk:        ${RISK_PCT}% of collateral per spread, ${MAX_HOLD_MIN} min max hold`);
  console.log(
    `  thresholds:  enter past ${PAIR_THRESHOLDS.ENTRY_Z}σ, stand aside past ${PAIR_THRESHOLDS.MAX_ENTRY_Z}σ, ` +
      `exit at ${PAIR_THRESHOLDS.EXIT_Z}σ, stop at ${PAIR_THRESHOLDS.STOP_Z}σ`,
  );
  console.log("");
  console.log("  The exit lives in this process, not on the exchange — a pair's risk is the");
  console.log("  spread, and no single order triggers on a spread. If this stops, the legs stay");
  console.log("  open and hedged, and it picks them back up on restart.");
  console.log("");

  for (const symbol of SYMBOLS) {
    const feed = createSweepFeed({ symbol });
    feeds.set(symbol, feed);
    feed.onState((st) => {
      if (st.mid !== null) dislocation.record(symbol, st.mid);
    });
    getEngine(symbol).start();
    try {
      precision.set(symbol, (await fetchMeta(symbol)).quantityPrecision);
    } catch {
      precision.set(symbol, 3);
    }
  }

  open = readJournal();
  if (open) {
    log(
      `resuming a pair opened ${Math.round((Date.now() - open.openedAt) / 60_000)} min ago: ` +
        `short ${open.richSymbol}, long ${open.cheapSymbol} at ${open.entryZ.toFixed(2)}σ`,
    );
    if (ARMED && hasCredentials()) {
      // Verify it is actually still there. A journal describing a pair the
      // exchange no longer holds would have this process managing a ghost.
      const cfg = loadConfig();
      const live = await Promise.all([
        fetchPosition(cfg, open.richSymbol).catch(() => null),
        fetchPosition(cfg, open.cheapSymbol).catch(() => null),
      ]);
      const held = live.filter(Boolean).length;
      if (held === 0) {
        log("...but neither leg is open any more — clearing the journal");
        open = null;
        writeJournal(null);
      } else if (held === 1) {
        log(
          `!! only one leg is still open — this is an UNHEDGED directional position. ` +
            `Closing it rather than pretending the pair survived.`,
        );
        await closePair(cfg, [open.richSymbol, open.cheapSymbol]).then((r) => log(r.detail));
        open = null;
        writeJournal(null);
      }
    }
  }

  setInterval(() => {
    void evaluate().catch((err) => log(`cycle failed: ${redact(err instanceof Error ? err.message : String(err))}`));
    beat("sweep-pairs", () => ({ symbols: SYMBOLS.length, open: open ? 1 : 0, tradesToday }));
  }, EVAL_MS).unref?.();

  log(`watching ${SYMBOLS.length} contracts — the spread needs about 20 minutes of history before it reads`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("");
    if (open) {
      console.log("  A pair is still open. Both legs stay on the exchange, hedged, and this");
      console.log("  picks them up on restart. Nothing was closed.");
    }
    process.exit(0);
  });
}

void main();
