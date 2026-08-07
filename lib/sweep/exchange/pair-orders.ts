import { fetchPosition, signedRequest, type BinanceConfig } from "./binance";
import { closePosition } from "./orders";

/**
 * Opening and closing both legs of a hedged pair.
 *
 * One rule governs this file, and it is not the same rule that governs a single
 * position. There, the hazard is a position with no stop. Here, the hazard is
 * **half a pair**: one leg filled and the other not. That is not a smaller
 * version of the intended trade, it is a completely different one — a naked
 * directional position at the full gross size, in a structure whose entire
 * purpose was to have no directional exposure, arrived at by accident while
 * nobody was watching.
 *
 * So the second leg failing unwinds the first, immediately, at market. That
 * costs a round trip and it is not negotiable: a pair that cannot be completed
 * is not a position to be managed, it is a mistake to be reversed. The same
 * applies on the way out — a close that only takes one leg off leaves the other
 * naked, so the remaining leg is retried rather than reported and left.
 *
 * There are no protective stops on the legs. That is deliberate and it is the
 * other thing that differs from a directional position. A stop on each leg
 * independently is worse than none: whichever moves against you first gets
 * closed, and what remains is exactly the naked exposure above. The risk on a
 * pair is the spread, the spread is not a price any single order can trigger
 * on, and so the exit has to be driven by the process watching it. That makes
 * this the one part of the system that does *not* survive the process dying —
 * which is why the runner journals the pair and reconciles it on restart.
 */

export interface PairLegOrder {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: string;
}

export interface PairFill {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  avgPrice: number;
}

export interface PairOpenResult {
  ok: boolean;
  fills: PairFill[];
  /** Set when the pair could not be completed and the first leg was unwound. */
  unwound: string | null;
  detail: string;
}

interface RawOrder {
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  executedQty?: string;
  avgPrice?: string;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function market(cfg: BinanceConfig, leg: PairLegOrder, reduceOnly = false): Promise<PairFill> {
  const raw = await signedRequest<RawOrder>(cfg, "POST", "/fapi/v1/order", {
    symbol: leg.symbol,
    side: leg.side,
    type: "MARKET",
    quantity: leg.quantity,
    ...(reduceOnly ? { reduceOnly: true } : {}),
  });
  return {
    symbol: raw.symbol,
    side: raw.side,
    quantity: num(raw.executedQty),
    avgPrice: num(raw.avgPrice),
  };
}

/**
 * Open both legs, or neither.
 *
 * The legs go out sequentially rather than in parallel. Parallel is faster and
 * halves the slippage window, and it is the wrong trade-off here: two in-flight
 * orders can both fail, both succeed, or split — and the split case has to be
 * detected before it can be unwound, which means waiting for both anyway. The
 * sequence makes the failure states enumerable, which matters more than the
 * hundred milliseconds.
 */
export async function openPair(
  cfg: BinanceConfig,
  first: PairLegOrder,
  second: PairLegOrder,
): Promise<PairOpenResult> {
  let firstFill: PairFill;
  try {
    firstFill = await market(cfg, first);
  } catch (err) {
    return {
      ok: false,
      fills: [],
      unwound: null,
      detail: `first leg (${first.symbol}) rejected, nothing was opened: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const secondFill = await market(cfg, second);
    if (secondFill.quantity <= 0) throw new Error("second leg reported no fill");
    return {
      ok: true,
      fills: [firstFill, secondFill],
      unwound: null,
      detail:
        `${first.side} ${firstFill.quantity} ${first.symbol} at ${firstFill.avgPrice}, ` +
        `${second.side} ${secondFill.quantity} ${second.symbol} at ${secondFill.avgPrice}`,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    /*
     * Half a pair is a naked position at gross size. Reverse it now.
     *
     * The unwind is retried, because the failure that got here is often a
     * transient the retry clears, and the cost of not clearing it is carrying
     * unhedged exposure until a human notices. If every attempt fails the
     * position is reported in the detail so the runner can shout about it
     * rather than logging a refusal and moving on.
     */
    let unwindError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await closePosition(cfg, first.symbol);
        const left = await fetchPosition(cfg, first.symbol);
        if (!left || left.positionAmt === 0) {
          return {
            ok: false,
            fills: [firstFill],
            unwound: first.symbol,
            detail: `second leg (${second.symbol}) failed — ${why}. First leg was unwound; the account is flat.`,
          };
        }
        unwindError = `still holding ${left.positionAmt}`;
      } catch (e) {
        unwindError = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }

    return {
      ok: false,
      fills: [firstFill],
      unwound: null,
      detail:
        `!! second leg (${second.symbol}) failed — ${why} — AND the first leg could not be unwound ` +
        `(${unwindError}). ${first.symbol} is open and UNHEDGED. Close it by hand.`,
    };
  }
}

export interface PairCloseResult {
  ok: boolean;
  closed: string[];
  stillOpen: string[];
  detail: string;
}

/**
 * Take both legs off.
 *
 * Both are attempted regardless of whether the first succeeded: stopping on the
 * first failure is how a close leaves the other leg naked. Whatever is left
 * open afterwards is named, because that is the state that needs a human.
 */
export async function closePair(cfg: BinanceConfig, symbols: string[]): Promise<PairCloseResult> {
  const closed: string[] = [];
  const stillOpen: string[] = [];
  const errors: string[] = [];

  for (const symbol of symbols) {
    try {
      await closePosition(cfg, symbol);
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verified against the exchange rather than inferred from the calls
  // succeeding — a reduce-only order can be accepted and fill for less than the
  // whole position.
  for (const symbol of symbols) {
    try {
      const left = await fetchPosition(cfg, symbol);
      if (!left || left.positionAmt === 0) closed.push(symbol);
      else stillOpen.push(`${symbol} (${left.positionAmt})`);
    } catch {
      stillOpen.push(`${symbol} (could not verify)`);
    }
  }

  return {
    ok: stillOpen.length === 0,
    closed,
    stillOpen,
    detail:
      stillOpen.length === 0
        ? `both legs closed: ${closed.join(", ")}`
        : `!! ${stillOpen.join(" and ")} still open after a close attempt — the pair is no longer hedged` +
          (errors.length ? ` (${errors.join("; ")})` : ""),
  };
}
