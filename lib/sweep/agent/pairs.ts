import type { DislocationRead } from "../metrics/dislocation";

/**
 * A market-neutral spread between two correlated perpetuals.
 *
 * What this is, stated precisely, because the loose version of the idea is
 * dangerous. It is **not** an arbitrage. An arbitrage needs a mechanism forcing
 * two prices back together — the same asset in two venues, a creation basket, a
 * deliverable future against its spot. BTC and ETH have none of that. They move
 * together because they are exposed to the same flows, and nothing whatsoever
 * obliges them to keep doing so.
 *
 * It is **not** risk-free either, and the phrase "delta neutral" invites that
 * reading. Netting the directional exposure removes one risk and leaves
 * another: the spread itself. A pair can be perfectly delta-neutral and still
 * lose steadily while one leg outperforms the other for a week. The thing being
 * bet on is that the *relationship* holds, and relationships break — usually
 * when something happens to one of the names, which is exactly when the
 * position is largest and the correlation the sizing assumed no longer exists.
 *
 * What it does buy, and why it is worth running on a weekend:
 *
 *  - The dominant source of variance in a crypto book is the market factor.
 *    Netting it out leaves a residual whose volatility is a fraction of either
 *    leg's, so the same dollar of risk buys a much tighter stop.
 *  - That residual mean-reverts more reliably than direction does, over
 *    horizons of minutes to hours, because a divergence with no news behind it
 *    is usually one participant's flow rather than a repricing.
 *  - It has no view on whether the market goes up or down, which is the view
 *    hardest to hold through a weekend nobody is watching.
 *
 * Beta-weighted rather than dollar-weighted. Equal notional on two legs of
 * different volatility is not neutral — it is a short position in the livelier
 * one. Beta is measured from the same return window the correlation is, so the
 * hedge ratio and the confidence in it come from one estimate.
 */

/** Below this correlation the two are not a pair and nothing is proposed. */
const MIN_CORRELATION = 0.6;
/** Entry threshold on the spread's own z-score. */
const ENTRY_Z = 1.6;
/** Beyond this the divergence is more likely news than flow; stand aside. */
const MAX_ENTRY_Z = 3.2;
/** Exit once the spread has come back inside this. */
const EXIT_Z = 0.4;
/** Give up if the spread widens this far past entry. */
const STOP_Z = 3.6;
/** Beta is clamped here — an estimate outside this is noise, not a hedge ratio. */
const MIN_BETA = 0.25;
const MAX_BETA = 4;

export interface PairLeg {
  symbol: string;
  side: "long" | "short";
  notionalUsd: number;
  price: number;
}

export interface PairProposal {
  ok: true;
  /** The name that has run ahead of the other. */
  rich: string;
  cheap: string;
  legs: [PairLeg, PairLeg];
  /** Hedge ratio applied — how much of the second leg per dollar of the first. */
  beta: number;
  correlation: number;
  z: number;
  /** Where the spread is expected to go, in z. */
  targetZ: number;
  /** Where the trade is abandoned, in z. */
  stopZ: number;
  /** Combined notional across both legs. */
  grossNotionalUsd: number;
  /** Net directional exposure after the hedge. Near zero is the point. */
  netDeltaUsd: number;
  reasoning: string[];
}

export interface PairRefusal {
  ok: false;
  reasons: string[];
}

export type PairResult = PairProposal | PairRefusal;

export interface PairInput {
  /** The contract the dislocation read is about. */
  symbol: string;
  /** Its peer. Exactly one, so the hedge ratio is well defined. */
  peer: string;
  dislocation: DislocationRead;
  /**
   * How much this contract moves per unit of the peer, from the same return
   * window the correlation came from.
   */
  beta: number;
  priceA: number;
  priceB: number;
  /** Free collateral in USDT. */
  equity: number;
  /** Fraction of equity to put at risk if the spread stop is hit. */
  riskFraction: number;
  /** Ceiling on combined notional across both legs. */
  maxGrossNotionalUsd: number;
  /** Standard deviation of the spread, in percent, for sizing the stop. */
  spreadVolPct: number;
  /** Round-trip cost per leg, in percent. Two legs means paying it twice. */
  roundTripPctPerLeg: number;
}

export function proposePair(input: PairInput): PairResult {
  const reasons: string[] = [];
  const reasoning: string[] = [];
  const d = input.dislocation;

  if (!d.warm) reasons.push("not enough shared history to measure a spread yet");
  if (!(input.priceA > 0) || !(input.priceB > 0)) reasons.push("no price on one of the legs");
  if (!(input.equity > 0)) reasons.push("no free collateral");
  if (input.maxGrossNotionalUsd <= 0) reasons.push("gross notional cap is 0 — set it first");

  if (d.warm && d.correlation < MIN_CORRELATION) {
    reasons.push(
      `${input.symbol} and ${input.peer} have only been ${(d.correlation * 100).toFixed(0)}% correlated — ` +
        `below ${(MIN_CORRELATION * 100).toFixed(0)}% they are not a pair and the hedge would not hedge`,
    );
  }

  const z = d.z;
  if (d.warm && Math.abs(z) < ENTRY_Z) {
    reasons.push(`spread is ${z.toFixed(2)}σ from its mean, inside the ${ENTRY_Z}σ entry threshold`);
  }
  /*
   * The far tail is refused rather than treated as the best possible entry.
   *
   * This is the single most important rule here and the least intuitive: the
   * larger the divergence, the *worse* the trade, past a point. Ordinary flow
   * does not separate two correlated majors by three and a half standard
   * deviations. What does is news about one of them — a listing, an exploit, an
   * unlock — and those do not revert. Fading the biggest divergence on the
   * screen is how a market-neutral book takes its largest directional loss.
   */
  if (d.warm && Math.abs(z) > MAX_ENTRY_Z) {
    reasons.push(
      `spread is ${z.toFixed(2)}σ apart, past the ${MAX_ENTRY_Z}σ ceiling — a gap that wide is usually ` +
        `news about one of the names rather than flow, and news does not revert`,
    );
  }

  const beta = Math.min(MAX_BETA, Math.max(MIN_BETA, input.beta));
  if (input.beta !== beta && d.warm) {
    reasoning.push(
      `beta measured at ${input.beta.toFixed(2)}, clamped to ${beta.toFixed(2)} — outside that range the ` +
        `estimate is noise rather than a hedge ratio`,
    );
  }

  if (reasons.length) return { ok: false, reasons };

  /* ------------------------------------------------------------------ sizing */

  /*
   * The stop is on the spread, not on either leg.
   *
   * A stop on each leg independently is worse than no stop: whichever leg moves
   * against you first gets closed, and what remains is a naked directional
   * position at full size — the exact exposure the structure existed to remove,
   * arrived at automatically, at the worst moment.
   */
  const stopDistanceZ = STOP_Z - Math.abs(z);
  const stopPct = Math.max(0.05, stopDistanceZ * input.spreadVolPct);
  const riskUsd = input.equity * input.riskFraction;

  // Gross is split across two legs, so the spread move applies to the combined
  // exposure and the cost is paid twice.
  let gross = riskUsd / (stopPct / 100);
  if (gross > input.maxGrossNotionalUsd) {
    gross = input.maxGrossNotionalUsd;
    reasoning.push(`capped at the ${input.maxGrossNotionalUsd} gross notional ceiling`);
  }

  /*
   * Beta-weighted split, not fifty-fifty.
   *
   * Equal notional on two legs of different volatility is not neutral; it is a
   * short position in whichever moves more. The legs are sized so their
   * expected dollar moves cancel: if A moves `beta` times as much as B, A gets
   * proportionally less notional.
   */
  const notionalA = gross / (1 + beta);
  const notionalB = gross - notionalA;

  const richIsA = z > 0; // this contract has outrun its peer
  const legA: PairLeg = {
    symbol: input.symbol,
    side: richIsA ? "short" : "long",
    notionalUsd: notionalA,
    price: input.priceA,
  };
  const legB: PairLeg = {
    symbol: input.peer,
    side: richIsA ? "long" : "short",
    notionalUsd: notionalB,
    price: input.priceB,
  };

  // What is left pointing at the market after the hedge. Reported rather than
  // assumed to be zero, because beta is an estimate and the residual is real.
  const netDeltaUsd =
    (legA.side === "long" ? notionalA : -notionalA) * beta +
    (legB.side === "long" ? notionalB : -notionalB);

  const expectedMovePct = (Math.abs(z) - EXIT_Z) * input.spreadVolPct;
  const costPct = input.roundTripPctPerLeg * 2;
  if (expectedMovePct < costPct * 2) {
    return {
      ok: false,
      reasons: [
        `the spread reverting to ${EXIT_Z}σ is worth ${expectedMovePct.toFixed(3)}% against ` +
          `${costPct.toFixed(3)}% of round trips on two legs — a pair pays the cost twice, and this ` +
          `one does not clear it`,
      ],
    };
  }

  reasoning.push(
    `${legA.side === "short" ? input.symbol : input.peer} has outrun ` +
      `${legA.side === "short" ? input.peer : input.symbol} by ${Math.abs(z).toFixed(2)}σ ` +
      `at ${(d.correlation * 100).toFixed(0)}% correlation`,
    `short the rich leg, long the cheap one, beta-weighted ${beta.toFixed(2)} so the market move cancels`,
    `risking ${riskUsd.toFixed(2)} on a ${stopPct.toFixed(2)}% spread move (${STOP_Z}σ), ` +
      `targeting a return to ${EXIT_Z}σ`,
    `net directional exposure ${netDeltaUsd >= 0 ? "+" : ""}${netDeltaUsd.toFixed(0)} of ${gross.toFixed(0)} gross ` +
      `— the residual the beta estimate leaves behind, not a view`,
  );

  return {
    ok: true,
    rich: legA.side === "short" ? input.symbol : input.peer,
    cheap: legA.side === "short" ? input.peer : input.symbol,
    legs: [legA, legB],
    beta,
    correlation: d.correlation,
    z,
    targetZ: Math.sign(z) * EXIT_Z,
    stopZ: Math.sign(z) * STOP_Z,
    grossNotionalUsd: gross,
    netDeltaUsd,
    reasoning,
  };
}

/** Whether an open pair should be closed, and why. */
export function shouldClosePair(
  entryZ: number,
  currentZ: number,
  heldMs: number,
  maxHoldMs: number,
): { close: boolean; reason: string } {
  // Reverted: the trade worked.
  if (Math.abs(currentZ) <= EXIT_Z) {
    return { close: true, reason: `spread came back to ${currentZ.toFixed(2)}σ — target reached` };
  }
  // Crossed through zero and out the other side. The relationship inverted
  // rather than reverted, and holding is a fresh trade nobody decided to take.
  if (Math.sign(currentZ) !== Math.sign(entryZ) && Math.abs(currentZ) > EXIT_Z) {
    return { close: true, reason: `spread inverted to ${currentZ.toFixed(2)}σ — this is now the opposite trade` };
  }
  if (Math.abs(currentZ) >= STOP_Z) {
    return { close: true, reason: `spread widened to ${currentZ.toFixed(2)}σ, past the ${STOP_Z}σ stop` };
  }
  if (maxHoldMs > 0 && heldMs >= maxHoldMs) {
    return {
      close: true,
      reason: `held ${Math.round(heldMs / 60_000)} min without reverting — the reading it was opened on has expired`,
    };
  }
  return { close: false, reason: `${currentZ.toFixed(2)}σ, waiting for ${EXIT_Z}σ` };
}

export const PAIR_THRESHOLDS = {
  MIN_CORRELATION,
  ENTRY_Z,
  MAX_ENTRY_Z,
  EXIT_Z,
  STOP_Z,
} as const;
