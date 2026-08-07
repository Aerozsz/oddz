/**
 * What the venue refused, what to do about it now, and what to change if it
 * keeps happening.
 *
 * The post-mortem loop learns from trades that *happened*. This one learns from
 * orders that never became trades, which is a different kind of evidence and
 * needs different handling: a rejection is unambiguous. There is no sampling
 * error in "margin is insufficient" — the exchange is not offering an opinion,
 * it is stating a fact about the account. So where the outcome tuner waits for
 * dozens of trades and confidence intervals, this can act on the first
 * occurrence, and the discipline it needs instead is about *which* action.
 *
 * Three failure modes to avoid, each of which has bitten real systems:
 *
 *  1. **Retrying what cannot succeed.** A rejected order re-sent unchanged is a
 *     loop, and against a rate limiter it is an escalating one that ends in an
 *     IP ban. Nothing here retries without changing something.
 *  2. **Treating every rejection as a size problem.** The reflex fix for a
 *     refused order is "send less", and it is wrong for most codes. A clock
 *     that has drifted, an unsigned agreement, a bad key — shrinking the order
 *     changes nothing, and the shrinking persists after the real cause is
 *     fixed, leaving the account trading at a fraction of its intended size for
 *     reasons nobody remembers.
 *  3. **Adapting to a one-off.** A single margin rejection during a funding
 *     settlement is noise. The same rejection five times is a miscalibration.
 *     Immediate response and persistent change are therefore separate
 *     decisions with separate thresholds.
 *
 * The distinction that organises the whole table below is *whose fault it is*:
 * sizing, configuration, the account, the venue, or the clock. Only "sizing"
 * faults are ever answered by sending less.
 */

export type ConstraintKind =
  | "margin-short"
  | "notional-floor"
  | "precision"
  | "leverage-bracket"
  | "position-limit"
  | "order-limit"
  | "trigger-side"
  | "post-only-rejected"
  | "reduce-only"
  | "rate-limited"
  | "banned"
  | "not-permitted"
  | "auth"
  | "clock"
  | "price-band"
  | "wrong-endpoint"
  | "unknown";

/**
 * What to do with the order in hand.
 *
 * `abandon` is not failure — most rejections describe a setup that should not
 * be taken, and the next signal is a fresh decision priced on a fresh book.
 * Forcing a trade through is how a constraint becomes a loss.
 */
export type Immediate =
  | "retry-smaller"
  | "retry-rounded"
  | "retry-taker"
  | "retry-later"
  | "abandon"
  | "halt-symbol"
  | "halt-all";

export type Fault = "sizing" | "config" | "account" | "venue" | "clock";

export interface ConstraintResponse {
  code: number | null;
  kind: ConstraintKind;
  fault: Fault;
  immediate: Immediate;
  /** Size multiplier for a `retry-smaller`. Absent for every other action. */
  retryScale?: number;
  /** Attempts allowed for this kind before giving up on the order. */
  maxAttempts: number;
  /**
   * Occurrences within the window before a persistent change is proposed.
   * `null` means repeats never justify a cap change — the cause is elsewhere
   * and moving a number would only hide it.
   */
  adaptAfter: number | null;
  explain: string;
  /** What the operator has to do, when it is not something code can fix. */
  operatorAction?: string;
}

const NEVER_ADAPT = null;

/**
 * Every Binance USDⓈ-M rejection this system can provoke, and its answer.
 *
 * Ordered by how often it is likely to be seen rather than numerically,
 * because this table is read when something is broken.
 */
const TABLE: Record<number, Omit<ConstraintResponse, "code">> = {
  /* ------------------------------------------------------------ sizing */

  [-2019]: {
    kind: "margin-short",
    fault: "sizing",
    immediate: "retry-smaller",
    // Two thirds rather than a nibble. The gap between what was sent and what
    // the account can fund is usually the fee plus the exchange's own initial
    // margin rounding, but it can be much larger when a leverage bracket
    // silently reduced the applied leverage — and a sequence of 5% trims walks
    // into the rate limiter looking for a boundary that one decisive step
    // clears.
    retryScale: 0.66,
    maxAttempts: 2,
    adaptAfter: 3,
    explain:
      "The position needed more margin than the account had free. Usually the sized notional left no " +
      "headroom for the opening commission, or a leverage bracket capped the applied leverage below what " +
      "was requested so the same notional needed more margin than the sizer assumed.",
  },
  [-2018]: {
    kind: "margin-short",
    fault: "sizing",
    immediate: "retry-smaller",
    retryScale: 0.66,
    maxAttempts: 2,
    adaptAfter: 3,
    explain: "Balance insufficient for the order — the same shape of problem as -2019.",
  },
  [-2010]: {
    // NEW_ORDER_REJECTED is a family, and most of the family is margin.
    kind: "margin-short",
    fault: "sizing",
    immediate: "retry-smaller",
    retryScale: 0.66,
    maxAttempts: 2,
    adaptAfter: 4,
    explain:
      "The order was rejected on submission. This code covers several causes and the message carries the " +
      "specific one; the commonest by far is insufficient margin, so it is treated as a sizing fault first.",
  },
  [-2027]: {
    kind: "position-limit",
    fault: "sizing",
    immediate: "retry-smaller",
    // Binance's brackets step by large factors, so the next tier down is far.
    retryScale: 0.5,
    maxAttempts: 2,
    adaptAfter: 2,
    explain:
      "The position would exceed what Binance allows at the leverage in force. Their brackets tighten the " +
      "maximum position as leverage rises, so this is a leverage ceiling expressed as a size limit — the " +
      "durable fix is a lower leverage cap, not a smaller position.",
  },
  [-4028]: {
    kind: "leverage-bracket",
    fault: "config",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: 2,
    explain:
      "The leverage requested is not valid for this symbol at this notional. Binance's brackets allow high " +
      "leverage only on small positions.",
  },

  /* ------------------------------------------ too small, or badly formed */

  [-4164]: {
    kind: "notional-floor",
    fault: "config",
    // Deliberately not retried larger. Growing an order to clear a venue
    // minimum means the venue is choosing the position size, and it would be
    // chosen above the risk budget every time. Refusing is correct.
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: 3,
    explain:
      "The order was below the venue's minimum notional. Sizing up to clear it would let the exchange set " +
      "the position size instead of the risk budget, so the setup is skipped instead.",
    operatorAction:
      "Either the account is too small for this symbol at this risk setting, or the risk per trade is too " +
      "low for the contract. Raise risk per trade, or trade a symbol with a smaller minimum.",
  },
  [-1013]: {
    kind: "precision",
    fault: "config",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "A symbol filter rejected the order — lot size, tick size or minimum notional. The message names " +
      "which. This is a formatting fault, and no cap change repairs it.",
  },
  [-1111]: {
    kind: "precision",
    fault: "config",
    immediate: "retry-rounded",
    maxAttempts: 2,
    adaptAfter: NEVER_ADAPT,
    explain:
      "More decimal places than the contract accepts. The exchange's own precision for the symbol is the " +
      "authority and is re-read before retrying.",
  },
  [-4003]: {
    kind: "precision", fault: "config", immediate: "abandon", maxAttempts: 1, adaptAfter: NEVER_ADAPT,
    explain: "Quantity was zero or negative — a sizing bug rather than a venue constraint.",
  },
  [-4005]: {
    kind: "precision", fault: "config", immediate: "retry-smaller", retryScale: 0.5, maxAttempts: 2, adaptAfter: 2,
    explain: "Quantity above the maximum the contract accepts in one order.",
  },
  [-4131]: {
    kind: "price-band",
    fault: "venue",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "The counterparty best price did not meet the percent-price filter — the book is too thin or too wide " +
      "right now for a market order to be accepted. This is the venue refusing a bad fill on our behalf, and " +
      "waiting is the correct response.",
  },

  /* ----------------------------------------------------- protective orders */

  [-2021]: {
    kind: "trigger-side",
    fault: "config",
    immediate: "retry-rounded",
    maxAttempts: 2,
    adaptAfter: NEVER_ADAPT,
    explain:
      "The stop or target would have triggered immediately, because it was placed the wrong side of the " +
      "mark. Retried once with the trigger recomputed against a fresh mark.",
  },
  [-2022]: {
    kind: "reduce-only",
    fault: "venue",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "A reduce-only order was rejected, which nearly always means the position it was meant to close is " +
      "already flat. Nothing to do — and retrying would open a new position in the opposite direction.",
  },
  [-4045]: {
    kind: "order-limit",
    fault: "account",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: 2,
    explain:
      "The account is at its ceiling for resting stop orders. Usually orphaned brackets from positions that " +
      "closed without their protective orders being cancelled.",
    operatorAction: "Cancel stale conditional orders for this symbol on Binance, then retry.",
  },
  [-4120]: {
    kind: "wrong-endpoint",
    fault: "config",
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "A conditional order went to the retired endpoint. Binance moved stops and take-profits to the Algo " +
      "Order service; this build targets it, so seeing this means something still calls the old path.",
  },
  [-5022]: {
    kind: "post-only-rejected",
    fault: "venue",
    // Not automatic. Crossing after a post-only rejection pays the spread the
    // resting order existed to earn, and the mark-out test that chose to rest
    // is the same test that would have chosen to cross. Overriding it here
    // would quietly undo that decision on every busy tick.
    immediate: "abandon",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "A post-only entry would have crossed the spread and was rejected rather than filled as a taker. That " +
      "is the order type working: the next signal is priced fresh against a fresh book.",
  },

  /* --------------------------------------------------- pace and permission */

  [-1003]: {
    kind: "rate-limited",
    fault: "venue",
    immediate: "retry-later",
    maxAttempts: 3,
    adaptAfter: 3,
    explain: "Too many requests. Backing off is the only correct response; retrying faster earns a ban.",
  },
  [-1015]: {
    kind: "rate-limited", fault: "venue", immediate: "retry-later", maxAttempts: 3, adaptAfter: 3,
    explain:
      "Too many new orders inside Binance's rolling window. This is the order-count limiter rather than the " +
      "request-weight one, so it is reached by trading frequently rather than by polling — which makes the " +
      "trade rate, not the poll rate, the thing to bring down.",
  },
  [-1021]: {
    kind: "clock",
    fault: "clock",
    // Halting rather than retrying: every subsequent signed request will fail
    // the same way, so retrying converts one clear error into a flood that
    // buries it.
    immediate: "halt-all",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain: "The request timestamp was outside Binance's window — this machine's clock has drifted.",
    operatorAction:
      "Sync the system clock (Windows: Settings > Time & language > Date & time > Sync now; " +
      "Linux: sudo systemctl restart systemd-timesyncd), then re-arm.",
  },
  [-2014]: {
    kind: "auth", fault: "account", immediate: "halt-all", maxAttempts: 1, adaptAfter: NEVER_ADAPT,
    explain:
      "The API key was malformed — usually whitespace or a line break picked up when it was pasted into " +
      ".env, which is invisible in an editor and rejects every request identically.",
    operatorAction: "Check BINANCE_API_KEY in .env, then run npm run sweep:check.",
  },
  [-2015]: {
    kind: "auth",
    fault: "account",
    immediate: "halt-all",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "The key was rejected — invalid, without Futures permission, or called from an IP outside its " +
      "allowlist. All three present identically and have different fixes.",
    operatorAction: "Run npm run sweep:check, which distinguishes the three.",
  },
  [-4411]: {
    kind: "not-permitted",
    fault: "account",
    // Symbol-scoped, not account-scoped: other contracts are unaffected and
    // stopping them would turn one missing signature into a full outage.
    immediate: "halt-symbol",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "This is a traditional-asset perpetual and Binance requires a separate agreement per account before " +
      "accepting any order on one. No amount of resizing or retrying changes that.",
    operatorAction:
      "Sign it on Binance under Trading Rules for Traditional Asset Perpetuals. The agreement is per " +
      "account, so demo and live are separate. On demo that modal often fails with 'System abnormality', " +
      "in which case the contract cannot be tested there — prove the order path on a crypto pair instead.",
  },
};

/** HTTP-level refusals, which carry no Binance code. */
const HTTP: Record<number, Omit<ConstraintResponse, "code">> = {
  429: {
    kind: "rate-limited", fault: "venue", immediate: "retry-later", maxAttempts: 3, adaptAfter: 3,
    explain: "Rate limited at the HTTP layer. Back off — the next step after ignoring this is a ban.",
  },
  418: {
    kind: "banned",
    fault: "venue",
    immediate: "halt-all",
    maxAttempts: 1,
    adaptAfter: NEVER_ADAPT,
    explain:
      "This IP is banned for continuing to send requests after being rate limited. Bans escalate from two " +
      "minutes to three days on repeat, so continuing to call is actively harmful.",
    operatorAction: "Stop the agent, wait out the ban, and reduce the trade rate before re-arming.",
  },
};

const UNKNOWN: Omit<ConstraintResponse, "code"> = {
  kind: "unknown",
  fault: "venue",
  // Abandon rather than retry. An error nobody has classified is the last thing
  // that should be sent again automatically — the whole point of not knowing
  // what it means is not knowing whether repeating it is safe.
  immediate: "abandon",
  maxAttempts: 1,
  adaptAfter: NEVER_ADAPT,
  explain: "An error this build does not recognise. The order was abandoned rather than retried blindly.",
};

/**
 * Read a thrown error and decide what it means.
 *
 * Matches the Binance code first and the HTTP status only as a fallback,
 * because a 400 carrying -2019 is a sizing problem and a bare 400 is not, and
 * conflating them would answer a permission error by shrinking the position.
 */
export function classifyConstraint(err: unknown): ConstraintResponse {
  const message = err instanceof Error ? err.message : String(err ?? "");

  const codeMatch = message.match(/"code"\s*:\s*(-?\d+)/);
  if (codeMatch) {
    const code = Number(codeMatch[1]);
    const known = TABLE[code];
    if (known) return { ...known, code };
    return { ...UNKNOWN, code, explain: `${UNKNOWN.explain} (code ${code})` };
  }

  const httpMatch = message.match(/\b(4\d\d|5\d\d)\b/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const known = HTTP[status];
    if (known) return { ...known, code: status };
    if (status >= 500) {
      return {
        code: status,
        kind: "unknown",
        fault: "venue",
        // The venue's own fault and usually transient, which is the one case
        // where re-sending the same request unchanged is the right answer.
        immediate: "retry-later",
        maxAttempts: 2,
        adaptAfter: NEVER_ADAPT,
        explain: `Binance returned ${status} — their side, usually brief. Retried after a pause.`,
      };
    }
  }

  // A network failure never reached the exchange, so nothing was accepted and
  // nothing needs resizing.
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(message)) {
    return {
      code: null,
      kind: "unknown",
      fault: "venue",
      immediate: "retry-later",
      maxAttempts: 2,
      adaptAfter: NEVER_ADAPT,
      explain: "The request never reached Binance. Nothing was submitted, so nothing needs to change.",
    };
  }

  return { ...UNKNOWN, code: null };
}

/* ------------------------------------------------------------ the memory */

export interface ConstraintEvent {
  at: number;
  symbol: string;
  kind: ConstraintKind;
  code: number | null;
  detail: string;
}

/**
 * How often each constraint has fired lately.
 *
 * Windowed, because "this happened five times" only means something with a
 * "when" attached. Five margin rejections in an hour is a miscalibration; five
 * over three weeks is five unrelated bad moments, and reacting to the second as
 * though it were the first leaves the account permanently smaller for reasons
 * that expired long ago.
 */
export class ConstraintMemory {
  private events: ConstraintEvent[] = [];

  constructor(private readonly windowMs = 6 * 3_600_000) {}

  record(e: ConstraintEvent) {
    this.events.push(e);
    this.prune(e.at);
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0].at < cutoff) this.events.shift();
    // A hard ceiling as well as a time window: a pathological loop could
    // otherwise fill memory faster than the window empties it.
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  count(kind: ConstraintKind, symbol?: string, now = Date.now()): number {
    this.prune(now);
    return this.events.filter((e) => e.kind === kind && (!symbol || e.symbol === symbol)).length;
  }

  recent(limit = 20): ConstraintEvent[] {
    return this.events.slice(-limit).reverse();
  }

  all(now = Date.now()): ConstraintEvent[] {
    this.prune(now);
    return [...this.events];
  }

  /** Distinct kinds seen, with counts — what the page shows. */
  summary(now = Date.now()): { kind: ConstraintKind; count: number; last: number; detail: string }[] {
    this.prune(now);
    const by = new Map<ConstraintKind, { count: number; last: number; detail: string }>();
    for (const e of this.events) {
      const cur = by.get(e.kind);
      by.set(e.kind, {
        count: (cur?.count ?? 0) + 1,
        last: Math.max(cur?.last ?? 0, e.at),
        detail: e.detail,
      });
    }
    return [...by.entries()]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.count - a.count);
  }

  /** Wipe one kind after the operator has fixed its cause. */
  clear(kind?: ConstraintKind) {
    this.events = kind ? this.events.filter((e) => e.kind !== kind) : [];
  }
}
