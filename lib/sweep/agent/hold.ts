import type { AgentState } from "./types";

/**
 * How long to hold, decided from whether the reason for the trade is still
 * true — not from a clock.
 *
 * The rule this replaces was a flat thirty minutes, derived from a week of real
 * trades where every bucket past that mark lost money. The finding was real and
 * the inference from it was wrong, in a way worth spelling out because it is the
 * whole argument for this file.
 *
 * Those trades were held past thirty minutes *because they were losing*. Nobody
 * voluntarily keeps a winner open while refusing to close a loser; the causation
 * runs from the loss to the holding time, not the other way. The time limit
 * worked — it turned that week from -8,873 to +3,263 — because it forcibly cut
 * positions that should have been cut on their own terms and were not. It was
 * standing in for a missing stop.
 *
 * The stop is no longer missing. It rests on the exchange, with a target beside
 * it and a break-even ratchet behind it, so the losers now close themselves. A
 * flat clock on top of that mostly cuts winners: a position that is 70% of the
 * way to its target at minute twenty-nine gets closed at minute thirty for no
 * reason connected to the trade.
 *
 * What actually bounds a trade here is that the *reading* it was opened on
 * decays. The entry said: the book is thin on one side, a cluster sits close,
 * and flow is pushing toward it. Each of those is observable, each expires on
 * its own schedule, and when they are gone the position is no longer the trade
 * that was justified — it is a directional bet nobody decided to take. So the
 * question is not "how long has this been open" but "is any of it still true",
 * and the answer moves the deadline rather than the deadline moving the trade.
 *
 * Three ways out, in the order they should fire:
 *
 *  1. **The thesis is dead.** The book refilled, the flow reversed, or the
 *     target got consumed by someone else. Close now regardless of the clock —
 *     this is the case a fixed limit handles far too slowly.
 *  2. **It never started.** No meaningful progress in the first stretch. A
 *     setup that was going to work usually begins working quickly, because the
 *     mechanism is a fast one; one that sits still was misread. Close early,
 *     well inside the nominal limit.
 *  3. **It is working.** Real progress with the flow still behind it earns
 *     extra time, capped. This is the only branch that extends anything, and it
 *     requires evidence rather than hope.
 *
 * The configured limit remains as a hard backstop that nothing can extend past.
 * Adaptive logic that can talk itself into holding forever is how the original
 * problem comes back wearing a cleverer hat.
 */

export interface HoldConfig {
  /** The operator's limit. Nothing extends past this multiple of it. */
  baseMinutes: number;
  /**
   * How far into the base window a position must show progress. Below
   * `minEarlyProgress` by then, it is closed.
   */
  stallFraction: number;
  minEarlyProgress: number;
  /** Progress that earns extra time. */
  workingProgress: number;
  /** The most the base limit can be stretched to, as a multiple. */
  maxExtension: number;
}

export const DEFAULT_HOLD: HoldConfig = {
  baseMinutes: 30,
  // A quarter of the way in. Long enough that ordinary noise around entry has
  // resolved, short enough that a dead trade is cut while the spread is still
  // the largest thing it has cost.
  stallFraction: 0.25,
  minEarlyProgress: 0.15,
  workingProgress: 0.55,
  maxExtension: 2.5,
};

export interface HoldInput {
  state: AgentState;
  side: "long" | "short";
  entryPrice: number;
  targetPrice: number | null;
  /** Milliseconds since the position opened. */
  heldMs: number;
  /**
   * Depth on the side that mattered at entry, as a multiple of baseline, when
   * the position was opened. The trade was justified by this being low.
   */
  entryLwi: number | null;
  config?: Partial<HoldConfig>;
}

export interface HoldDecision {
  close: boolean;
  reason: string;
  /** 0..1 — how much of the original reasoning still holds. */
  thesisHealth: number;
  /** Progress toward the target, 0..1. Negative when it has gone backwards. */
  progress: number;
  /** Where the deadline currently sits, in ms from entry. Moves with the trade. */
  deadlineMs: number;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function holdDecision(input: HoldInput): HoldDecision {
  const cfg = { ...DEFAULT_HOLD, ...input.config };
  const { state, side, entryPrice, heldMs } = input;
  const notes: string[] = [];
  const long = side === "long";
  const baseMs = cfg.baseMinutes * 60_000;
  const hardMs = baseMs * cfg.maxExtension;

  const mark = state.mark ?? state.mid ?? entryPrice;
  const travelled = long ? mark - entryPrice : entryPrice - mark;
  const distance = input.targetPrice !== null ? Math.abs(input.targetPrice - entryPrice) : 0;
  const progress = distance > 0 ? travelled / distance : 0;

  /* ------------------------------------------------- is the thesis still true */

  let health = 1;

  /*
   * The book refilling is the clearest expiry there is.
   *
   * The entry said one side was thin. If depth has come back to its baseline,
   * whoever stepped away has stepped back, and the cheap path to the cluster
   * that justified the trade no longer exists. Nothing about the price needs to
   * have moved for this to be over.
   */
  const liq = state.liquidity;
  /*
   * Only meaningful if the book was actually thin when the trade was opened.
   *
   * `1 - entryLwi` is the thinness being measured against: how far below
   * baseline the depth sat. When the entry was taken at or above baseline there
   * is no thinness, nothing can refill, and this exit does not apply.
   *
   * The previous form clamped that denominator to 0.1, which was catastrophic
   * rather than merely wrong. An entry at 1.11x gave a divisor of 0.1, so a
   * depth rise of 0.07 — ordinary tick-to-tick noise — computed as 0.7
   * recovery, took 0.7 off health, and closed the position immediately. Over a
   * weekend that produced 55 trades at a median hold of ninety seconds, every
   * single one closed by this branch, and $1,343 of commission against $1,583
   * of total loss: the account was not traded away, it was churned away.
   *
   * A floor of 0.05 rather than 0 keeps a barely-thin entry from dividing by
   * something near zero and reproducing the same explosion at the other end.
   */
  const thinnessAtEntry = input.entryLwi !== null ? 1 - input.entryLwi : 0;
  if (liq?.warm && input.entryLwi !== null && input.entryLwi > 0 && thinnessAtEntry > 0.05) {
    const nowLwi = long ? liq.lwiAskAdj : liq.lwiBidAdj;
    const recovery = (nowLwi - input.entryLwi) / thinnessAtEntry;
    if (recovery > 0.7) {
      // Decisive on its own. This is the fastest legitimate exit there is: the
      // condition that justified the entry has been directly observed to end,
      // and waiting for a clock or a price to confirm it just pays for the
      // confirmation.
      health -= 0.7;
      notes.push(
        `depth has refilled to ${nowLwi.toFixed(2)}x from ${input.entryLwi.toFixed(2)}x at entry — ` +
          `the thinness the trade was opened on is gone`,
      );
    } else if (recovery > 0.4) {
      health -= 0.2;
      notes.push(`depth is coming back (${nowLwi.toFixed(2)}x from ${input.entryLwi.toFixed(2)}x)`);
    }
  } else if (input.entryLwi !== null && thinnessAtEntry <= 0.05) {
    // Worth saying rather than silently skipping: an entry taken on a book that
    // was not thin is a signal problem, and it is invisible if the exit that
    // would have mentioned it simply does not run.
    notes.push(
      `opened at ${input.entryLwi.toFixed(2)}x depth — at or above baseline, so there was no thinness ` +
        `to expire and this trade is governed by its stop, target and clock alone`,
    );
  }

  /*
   * Flow turning against the position.
   *
   * Mark-out is the one reading scored against realised outcomes rather than
   * against the state of the book, which is why it is allowed to end a trade on
   * its own. `informed` positive means aggressive buying has been marking out in
   * its favour; for a short that is the market disagreeing with the position,
   * measured rather than felt.
   */
  const mk = state.markout;
  if (mk.warm) {
    const against = long ? -mk.informed : mk.informed;
    if (against > 0.45) {
      health -= 0.4;
      notes.push(
        `flow has turned — ${mk.notes[0] ?? "the other side has been marking out in its favour"}`,
      );
    } else if (against > 0.2) {
      health -= 0.15;
      notes.push("flow is no longer helping");
    } else if (against < -0.3) {
      health += 0.1;
      notes.push("flow is still behind the position");
    }
  }

  /*
   * The target being consumed by someone else.
   *
   * The reward this was sized against was a specific cluster. If it has been
   * spent — price traded through it without us, or the liquidations there have
   * already fired — the position is holding for a payout that no longer exists.
   */
  const ahead = long ? state.nearestAbove : state.nearestBelow;
  if (input.targetPrice !== null && distance > 0) {
    const stillThere =
      ahead !== null && Math.abs(ahead.price - input.targetPrice) / input.targetPrice < 0.002;
    if (!stillThere && progress < 0.8) {
      health -= 0.25;
      notes.push(`the level this was aimed at is no longer the nearest one ahead`);
    }
  }

  // A phase boundary changes every baseline the entry was read against.
  if (state.session.transitioning) {
    health -= 0.1;
    notes.push(`${state.session.intraday} just started — the readings behind this are mid-recalibration`);
  }

  health = clamp(health, 0, 1);

  /* --------------------------------------------------------------- deadline */

  /*
   * The deadline moves with the evidence, inside hard bounds.
   *
   * A working trade earns time up to `maxExtension`; a dying thesis loses it.
   * The floor is the stall window, so nothing can shrink the deadline to zero
   * and close a position that has simply not been given a chance yet.
   */
  const stallMs = baseMs * cfg.stallFraction;
  let deadlineMs = baseMs;
  if (progress >= cfg.workingProgress && health > 0.6) {
    deadlineMs = baseMs * (1 + (cfg.maxExtension - 1) * clamp(progress, 0, 1) * health);
    notes.push(
      `${(progress * 100).toFixed(0)}% of the way to target with the reasoning intact — ` +
        `the limit is extended to ${Math.round(deadlineMs / 60_000)} min`,
    );
  } else if (health < 0.5) {
    deadlineMs = Math.max(stallMs, baseMs * health);
  }
  deadlineMs = Math.min(hardMs, deadlineMs);

  /* ----------------------------------------------------------------- verdict */

  if (health <= 0.35) {
    return {
      close: true,
      reason: `the reason for this trade has expired — ${notes[0] ?? "conditions no longer match the entry"}`,
      thesisHealth: health,
      progress,
      deadlineMs,
      notes,
    };
  }

  if (heldMs >= stallMs && progress < cfg.minEarlyProgress) {
    return {
      close: true,
      reason:
        `${Math.round(heldMs / 60_000)} min in and only ${(progress * 100).toFixed(0)}% of the way to target — ` +
        `this mechanism works quickly when it works, and this one has not started`,
      thesisHealth: health,
      progress,
      deadlineMs,
      notes,
    };
  }

  if (heldMs >= deadlineMs) {
    return {
      close: true,
      reason:
        deadlineMs > baseMs
          ? `held ${Math.round(heldMs / 60_000)} min, past even the extended limit`
          : `held ${Math.round(heldMs / 60_000)} min — past the point where the book reading behind it means anything`,
      thesisHealth: health,
      progress,
      deadlineMs,
      notes,
    };
  }

  return {
    close: false,
    reason:
      `${(progress * 100).toFixed(0)}% to target, thesis ${(health * 100).toFixed(0)}% intact, ` +
      `${Math.round((deadlineMs - heldMs) / 60_000)} min left`,
    thesisHealth: health,
    progress,
    deadlineMs,
    notes,
  };
}
