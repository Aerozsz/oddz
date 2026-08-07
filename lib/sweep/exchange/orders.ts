import { fetchPosition, signedRequest, type BinanceConfig, type Position } from "./binance";

/**
 * Order placement, built around one rule: a position never exists without a
 * protective stop resting on the exchange.
 *
 * The reason is what happens when this process stops. A plan held in memory —
 * "close if it reaches 42" — dies with the process. An order sitting on
 * Binance's servers does not: it survives Ctrl-C, a crash, an OS update, a
 * dropped connection and a power cut, because it is not running here at all.
 *
 * So the agent is designed to leave positions in place on shutdown and pick
 * them up on restart, and that is only safe because the stop is on the exchange
 * rather than in this program. Without the stop, the only thing closing a
 * forgotten position is liquidation.
 */

export type Side = "BUY" | "SELL";

export interface Order {
  orderId: number;
  symbol: string;
  side: Side;
  type: string;
  stopPrice: number;
  closePosition: boolean;
  reduceOnly: boolean;
  quantity: number;
  /** How much of `quantity` has actually filled. Partial fills are the norm
   *  for a resting order, not an edge case. */
  executedQty: number;
  /** Average fill price, 0 until something fills. */
  avgPrice: number;
  /** Limit price, for a resting order. */
  price: number;
  status: string;
}

interface RawOrder {
  orderId: number;
  symbol: string;
  side: Side;
  type: string;
  stopPrice?: string;
  closePosition?: boolean;
  reduceOnly?: boolean;
  origQty?: string;
  executedQty?: string;
  avgPrice?: string;
  price?: string;
  status: string;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toOrder(o: RawOrder): Order {
  return {
    orderId: o.orderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    stopPrice: num(o.stopPrice),
    closePosition: Boolean(o.closePosition),
    reduceOnly: Boolean(o.reduceOnly),
    quantity: num(o.origQty),
    executedQty: num(o.executedQty),
    avgPrice: num(o.avgPrice),
    price: num(o.price),
    status: o.status,
  };
}

export async function listOpenOrders(cfg: BinanceConfig, symbol: string): Promise<Order[]> {
  const rows = await signedRequest<RawOrder[]>(cfg, "GET", "/fapi/v1/openOrders", { symbol });
  return rows.map(toOrder);
}

export async function cancelOrder(cfg: BinanceConfig, symbol: string, orderId: number): Promise<void> {
  await signedRequest(cfg, "DELETE", "/fapi/v1/order", { symbol, orderId });
}

/**
 * The stop that protects an open position.
 *
 * `closePosition=true` makes this a position-level order rather than a sized
 * one: it closes whatever is open when it fires, and Binance cancels it
 * automatically once the position is gone. That removes the two ways a sized
 * stop goes wrong — drifting out of step with the position after a partial
 * fill, and being left behind as a stray order that later opens a new position
 * in the opposite direction.
 *
 * Triggered on mark price, not last price. Binance liquidates on mark, and last
 * price can wick on thin books — a stop on last price gets taken out by a print
 * that never threatened the position.
 */
export async function placeProtectiveStop(
  cfg: BinanceConfig,
  symbol: string,
  position: Position,
  stopPrice: number,
  pricePrecision: number,
): Promise<Order> {
  if (position.positionAmt === 0) throw new Error("no position to protect");
  const long = position.positionAmt > 0;

  // A long is closed by selling; the stop sits below. A short is the mirror.
  if (long && stopPrice >= position.markPrice) {
    throw new Error(`long stop ${stopPrice} must be below mark ${position.markPrice}`);
  }
  if (!long && stopPrice <= position.markPrice) {
    throw new Error(`short stop ${stopPrice} must be above mark ${position.markPrice}`);
  }

  const raw = await signedRequest<RawOrder>(cfg, "POST", "/fapi/v1/order", {
    symbol,
    side: long ? "SELL" : "BUY",
    type: "STOP_MARKET",
    stopPrice: stopPrice.toFixed(pricePrecision),
    closePosition: true,
    workingType: "MARK_PRICE",
  });
  return toOrder(raw);
}

/** A resting order that would close this position if price runs against it. */
export function findProtectiveStop(orders: Order[], position: Position): Order | null {
  const long = position.positionAmt > 0;
  const closingSide: Side = long ? "SELL" : "BUY";
  return (
    orders.find(
      (o) =>
        o.side === closingSide &&
        o.type.includes("STOP") &&
        (o.closePosition || o.reduceOnly) &&
        o.stopPrice > 0 &&
        (long ? o.stopPrice < position.markPrice : o.stopPrice > position.markPrice),
    ) ?? null
  );
}

export interface ProtectionState {
  position: Position | null;
  stop: Order | null;
  protected: boolean;
  /** Distance from mark to the stop, percent. Null when unprotected or flat. */
  stopDistancePct: number | null;
  reason: string;
}

/**
 * What the exchange says about the position and its protection right now.
 *
 * Read from the exchange rather than from anything this process remembers,
 * because on restart this process remembers nothing — and that is exactly the
 * moment the answer matters.
 */
export async function checkProtection(
  cfg: BinanceConfig,
  symbol: string,
  position: Position | null,
): Promise<ProtectionState> {
  if (!position || position.positionAmt === 0) {
    return { position: null, stop: null, protected: true, stopDistancePct: null, reason: "flat" };
  }
  const orders = await listOpenOrders(cfg, symbol);
  const stop = findProtectiveStop(orders, position);
  if (!stop) {
    return {
      position,
      stop: null,
      protected: false,
      stopDistancePct: null,
      reason: "OPEN POSITION WITH NO STOP ON THE EXCHANGE — only liquidation would close it",
    };
  }
  const distance = Math.abs((stop.stopPrice - position.markPrice) / position.markPrice) * 100;
  return {
    position,
    stop,
    protected: true,
    stopDistancePct: distance,
    reason: `stop resting at ${stop.stopPrice} (${distance.toFixed(2)}% away)`,
  };
}

/**
 * Bring an unprotected position under a stop.
 *
 * Called on startup, so a position left behind by a previous run is covered
 * before anything else happens. `stopPct` is measured from the mark, not from
 * the entry: after a restart the entry may be far away, and the question that
 * matters is how much further this is allowed to go from here.
 */
export async function ensureProtected(
  cfg: BinanceConfig,
  symbol: string,
  position: Position | null,
  stopPct: number,
  pricePrecision: number,
): Promise<ProtectionState> {
  const state = await checkProtection(cfg, symbol, position);
  if (state.protected || !state.position) return state;

  const long = state.position.positionAmt > 0;
  const mark = state.position.markPrice;
  const stopPrice = long ? mark * (1 - stopPct / 100) : mark * (1 + stopPct / 100);
  const stop = await placeProtectiveStop(cfg, symbol, state.position, stopPrice, pricePrecision);

  return {
    position: state.position,
    stop,
    protected: true,
    stopDistancePct: stopPct,
    reason: `placed a protective stop at ${stop.stopPrice} (${stopPct}% from mark)`,
  };
}

/**
 * Open a position that is protected from the moment it exists.
 *
 * Entry and stop cannot be sent as one instruction, so there is a window
 * between them. It is handled by failing closed: if the stop cannot be placed,
 * the position just opened is closed again immediately. An entry that half
 * worked is worse than no entry, and the alternative is precisely the
 * unprotected position this module exists to prevent.
 */
export async function openProtectedPosition(
  cfg: BinanceConfig,
  symbol: string,
  side: Side,
  quantity: string,
  stopPct: number,
  pricePrecision: number,
): Promise<{ entry: Order; stop: Order }> {
  const entry = toOrder(
    await signedRequest<RawOrder>(cfg, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity,
    }),
  );

  try {
    const rows = await signedRequest<{ positionAmt: string; markPrice: string; entryPrice: string }[]>(
      cfg,
      "GET",
      "/fapi/v2/positionRisk",
      { symbol },
    );
    const raw = rows.find((r) => Number(r.positionAmt) !== 0);
    if (!raw) throw new Error("entry filled but no position is reported");

    const position = {
      symbol,
      positionAmt: num(raw.positionAmt),
      entryPrice: num(raw.entryPrice),
      markPrice: num(raw.markPrice),
      unrealizedPnl: 0,
      liquidationPrice: 0,
      leverage: 0,
      notional: 0,
      marginType: "cross",
      isolatedMargin: 0,
    } satisfies Position;

    const long = position.positionAmt > 0;
    const stopPrice = long
      ? position.markPrice * (1 - stopPct / 100)
      : position.markPrice * (1 + stopPct / 100);
    const stop = await placeProtectiveStop(cfg, symbol, position, stopPrice, pricePrecision);
    return { entry, stop };
  } catch (err) {
    await closePosition(cfg, symbol).catch(() => {
      /* reported below; the original failure is the more useful one */
    });
    throw new Error(
      `entry filled but the protective stop failed — position was closed again. Cause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Set the leverage Binance will apply to the next position.
 *
 * Nothing did this before, which meant a position opened at whatever the
 * account was last set to in the Binance UI — commonly the 20x maximum. The
 * sizer derives a leverage, the preview shows a liquidation price computed
 * from it, and the interlocks check it against a ceiling; none of that reaches
 * the exchange unless it is sent. A position opened at 20x when the model said
 * 2x has its liquidation price ten times nearer than the number on screen, and
 * every margin figure in the GUI is wrong.
 *
 * Idempotent, and -4046 ("no need to change leverage") is a success rather than
 * an error — it just means it was already set to this.
 */
export async function setLeverage(cfg: BinanceConfig, symbol: string, leverage: number): Promise<void> {
  const value = Math.max(1, Math.round(leverage));
  try {
    await signedRequest(cfg, "POST", "/fapi/v1/leverage", { symbol, leverage: value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("-4046")) return;
    throw new Error(`could not set leverage to ${value}x: ${message}`);
  }
}

/* ---------------------------------------------------------- maker entries */

export interface MakerEntryOptions {
  /** Give up and cancel after this long. */
  waitMs: number;
  /** How often to check whether it filled. */
  pollMs: number;
  /**
   * Abandon the order if price runs this far away from the limit, in percent.
   *
   * The case this exists for: the order rests, price leaves without it, and the
   * setup that justified the entry is gone — but the order is still sitting
   * there waiting to be filled by price coming back, which is now a different
   * and worse trade. A resting order is a standing offer to trade at a price
   * that made sense at the time, and the time expires.
   */
  abandonPct: number;
  /**
   * Keep a partial fill, or close it and start again.
   *
   * Keeping is the default. A partial fill is a real position and closing it
   * costs a taker fee in each direction to end up flat — paying 10bp to undo
   * the thing you paid 2bp to get. The stop is sized to whatever actually
   * filled, so a partial is protected exactly like a full one; it is simply
   * smaller than intended, which is the benign direction for a size error.
   */
  keepPartial: boolean;
}

export const DEFAULT_MAKER_ENTRY: MakerEntryOptions = {
  // Long enough to be filled by ordinary flow, short enough that the setup is
  // still the one that was measured. Beyond about half a minute the book has
  // usually moved on.
  waitMs: 20_000,
  pollMs: 1_000,
  abandonPct: 0.15,
  keepPartial: true,
};

export interface MakerEntryResult {
  /** Null when nothing filled at all. */
  order: Order | null;
  filledQty: number;
  avgPrice: number;
  /** What happened, for the log and for the operator. */
  outcome: "filled" | "partial" | "unfilled" | "rejected" | "abandoned";
  /** True when Binance refused the order because it would have crossed. */
  wouldHaveCrossed: boolean;
  reason: string;
}

/**
 * Place an entry that rests on the book rather than crossing it.
 *
 * `GTX` is the mechanism and the reason this is safe: Binance rejects the order
 * outright if it would match immediately, rather than filling it as a taker. So
 * there is no path where this quietly becomes the expensive execution it exists
 * to avoid — either it rests and earns the maker rate, or it is refused and the
 * caller decides what to do about that. Silently paying 10bp when 4bp was
 * quoted is exactly the failure worth engineering out.
 *
 * Nothing here places a stop. The caller does that against whatever actually
 * filled, because the amount that fills is not known in advance.
 */
export async function placeMakerEntry(
  cfg: BinanceConfig,
  symbol: string,
  side: Side,
  quantity: string,
  limitPrice: string,
  options: Partial<MakerEntryOptions> = {},
): Promise<MakerEntryResult> {
  const opts = { ...DEFAULT_MAKER_ENTRY, ...options };

  let order: Order;
  try {
    order = toOrder(
      await signedRequest<RawOrder>(cfg, "POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "LIMIT",
        // Post-only. Rejected rather than filled if it would take.
        timeInForce: "GTX",
        quantity,
        price: limitPrice,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // -5022 is Binance's "would immediately match" rejection, which is the
    // post-only guarantee working rather than an error to retry blindly.
    const crossed = message.includes("-5022") || message.toLowerCase().includes("post only");
    return {
      order: null,
      filledQty: 0,
      avgPrice: 0,
      outcome: "rejected",
      wouldHaveCrossed: crossed,
      reason: crossed
        ? `a resting order at ${limitPrice} would have crossed the spread — the book moved between pricing and sending`
        : `entry rejected: ${message}`,
    };
  }

  const limit = Number(limitPrice);
  const deadline = Date.now() + opts.waitMs;

  while (Date.now() < deadline) {
    await sleep(opts.pollMs);
    const live = await queryOrder(cfg, symbol, order.orderId);
    order = live;

    if (live.status === "FILLED") {
      return {
        order: live,
        filledQty: live.executedQty,
        avgPrice: live.avgPrice,
        outcome: "filled",
        wouldHaveCrossed: false,
        reason: `filled ${live.executedQty} at ${live.avgPrice} as a maker`,
      };
    }
    if (live.status === "CANCELED" || live.status === "EXPIRED" || live.status === "REJECTED") break;

    // Has price left this order behind? Measured against the mark rather than
    // the book, because the mark is what the stop and the liquidation price are
    // referenced to and it cannot be moved by a single thin print.
    const mark = await markPrice(cfg, symbol);
    if (mark > 0 && limit > 0) {
      const awayPct = ((side === "BUY" ? mark - limit : limit - mark) / limit) * 100;
      if (awayPct > opts.abandonPct) {
        const cancelled = await cancelAndRead(cfg, symbol, order.orderId);
        return settle(cancelled, "abandoned",
          `price moved ${awayPct.toFixed(2)}% away from the ${limitPrice} entry before it filled — ` +
            `the setup this was priced against no longer exists`);
      }
    }
  }

  const cancelled = await cancelAndRead(cfg, symbol, order.orderId);
  return settle(cancelled, "unfilled",
    `not filled within ${Math.round(opts.waitMs / 1000)}s at ${limitPrice}`);
}

function settle(order: Order, ifEmpty: MakerEntryResult["outcome"], reason: string): MakerEntryResult {
  // A cancel races the fill. Between deciding to cancel and the cancel landing,
  // the order can fill in whole or in part, so what matters is what the
  // exchange reports afterwards — never what was intended.
  if (order.executedQty > 0) {
    const full = order.executedQty >= order.quantity;
    return {
      order,
      filledQty: order.executedQty,
      avgPrice: order.avgPrice,
      outcome: full ? "filled" : "partial",
      wouldHaveCrossed: false,
      reason: full
        ? `filled ${order.executedQty} at ${order.avgPrice} just before the cancel landed`
        : `${reason} — but ${order.executedQty} of ${order.quantity} had already filled at ${order.avgPrice}`,
    };
  }
  return { order, filledQty: 0, avgPrice: 0, outcome: ifEmpty, wouldHaveCrossed: false, reason };
}

async function queryOrder(cfg: BinanceConfig, symbol: string, orderId: number): Promise<Order> {
  return toOrder(await signedRequest<RawOrder>(cfg, "GET", "/fapi/v1/order", { symbol, orderId }));
}

/**
 * Cancel, then read back what the exchange says the order did.
 *
 * The read-back is the point. A cancel that returns an error because the order
 * already filled is not a failure, it is a fill — and treating it as a failure
 * would leave an unprotected position, which is the one outcome this module
 * exists to prevent.
 */
async function cancelAndRead(cfg: BinanceConfig, symbol: string, orderId: number): Promise<Order> {
  try {
    return toOrder(await signedRequest<RawOrder>(cfg, "DELETE", "/fapi/v1/order", { symbol, orderId }));
  } catch {
    return queryOrder(cfg, symbol, orderId);
  }
}

async function markPrice(cfg: BinanceConfig, symbol: string): Promise<number> {
  try {
    const d = await signedRequest<{ markPrice: string }>(cfg, "GET", "/fapi/v1/premiumIndex", { symbol });
    return num(d.markPrice);
  } catch {
    // Not knowing the mark must not abandon a resting order; the timeout still
    // bounds it.
    return 0;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A maker entry with a protective stop attached to whatever actually filled.
 *
 * The maker equivalent of openProtectedPosition, and it fails closed the same
 * way. The extra hazard here is the partial fill: a position smaller than
 * intended is still a position, and it is unprotected until the stop lands. So
 * the stop is sized from the exchange's report of the position rather than from
 * what was ordered.
 */
export async function openProtectedMakerPosition(
  cfg: BinanceConfig,
  symbol: string,
  side: Side,
  quantity: string,
  limitPrice: string,
  stopPct: number,
  pricePrecision: number,
  options: Partial<MakerEntryOptions> = {},
): Promise<{ entry: MakerEntryResult; stop: Order | null }> {
  const entry = await placeMakerEntry(cfg, symbol, side, quantity, limitPrice, options);

  if (entry.filledQty <= 0) return { entry, stop: null };

  const opts = { ...DEFAULT_MAKER_ENTRY, ...options };
  if (entry.outcome === "partial" && !opts.keepPartial) {
    await closePosition(cfg, symbol).catch(() => {});
    return {
      entry: { ...entry, reason: `${entry.reason} — partial closed again, keepPartial is off` },
      stop: null,
    };
  }

  try {
    // Read the position back rather than assuming the fill size. A partial
    // fill, or a fill that landed on top of something already open, both make
    // "what was ordered" the wrong basis for a stop.
    const position = await fetchPosition(cfg, symbol);
    if (!position) throw new Error("entry reported a fill but no position is open");
    const state = await ensureProtected(cfg, symbol, position, stopPct, pricePrecision);
    return { entry, stop: state.stop };
  } catch (err) {
    await closePosition(cfg, symbol).catch(() => {});
    throw new Error(
      `maker entry filled ${entry.filledQty} but the protective stop failed — position was closed again. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Close whatever is open, at market. Used by the fail-closed path and by kill. */
export async function closePosition(cfg: BinanceConfig, symbol: string): Promise<void> {
  const rows = await signedRequest<{ positionAmt: string }[]>(cfg, "GET", "/fapi/v2/positionRisk", { symbol });
  const raw = rows.find((r) => Number(r.positionAmt) !== 0);
  if (!raw) return;
  const amt = num(raw.positionAmt);
  await signedRequest(cfg, "POST", "/fapi/v1/order", {
    symbol,
    side: amt > 0 ? "SELL" : "BUY",
    type: "MARKET",
    quantity: Math.abs(amt).toString(),
    reduceOnly: true,
  });
}
