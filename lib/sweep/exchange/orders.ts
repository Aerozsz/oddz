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
  /** orderId for an ordinary order; algoId for a conditional one. */
  orderId: number;
  /** True when this lives in the Algo Order service and cancels by algoId. */
  isAlgo?: boolean;
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

/* --------------------------------------------------------- algo orders */

/**
 * Conditional orders moved. Binance migrated STOP_MARKET, TAKE_PROFIT_MARKET,
 * STOP, TAKE_PROFIT and TRAILING_STOP_MARKET off /fapi/v1/order onto a separate
 * Algo Order service on 2025-12-09, and the old endpoint now rejects them
 * outright with -4120 rather than continuing to accept them.
 *
 * That is not a cosmetic change for this project. The protective stop is the
 * single property everything else rests on — positions are deliberately left
 * open on shutdown, and that is only safe because the stop lives on the
 * exchange. Against the old endpoint every stop now fails, so every entry would
 * be unwound by the fail-closed path and nothing could ever be held.
 *
 * The shape differs as well as the path:
 *   - `triggerPrice`, not `stopPrice`
 *   - `algoType: CONDITIONAL` alongside the order type
 *   - identified by `algoId`, not `orderId`
 *   - listed at /fapi/v1/openAlgoOrders, cancelled by algoId
 */
const ALGO_PATH = "/fapi/v1/algoOrder";

interface RawAlgoOrder {
  algoId: number;
  clientAlgoId?: string;
  algoType?: string;
  orderType?: string;
  symbol: string;
  side: Side;
  quantity?: string;
  triggerPrice?: string;
  price?: string;
  closePosition?: boolean;
  reduceOnly?: boolean;
  algoStatus?: string;
  workingType?: string;
}

/**
 * An algo order in the same shape as an ordinary one.
 *
 * `orderId` carries the algoId so a caller holding an Order can cancel it
 * without knowing which service it came from — `isAlgo` is what routes that.
 */
function fromAlgo(o: RawAlgoOrder): Order {
  return {
    orderId: o.algoId,
    isAlgo: true,
    symbol: o.symbol,
    side: o.side,
    type: o.orderType ?? "STOP_MARKET",
    stopPrice: num(o.triggerPrice),
    closePosition: Boolean(o.closePosition),
    reduceOnly: Boolean(o.reduceOnly),
    quantity: num(o.quantity),
    executedQty: 0,
    avgPrice: 0,
    price: num(o.price),
    status: o.algoStatus ?? "NEW",
  };
}

/**
 * Every resting order, from both services.
 *
 * Both are queried because a position's protection now lives in the algo
 * service while an unfilled entry still lives in the ordinary one, and
 * checkProtection has to see the first while the maker path has to see the
 * second. Querying only one is how a protected position reads as unprotected.
 */
export async function listOpenOrders(cfg: BinanceConfig, symbol: string): Promise<Order[]> {
  const [plain, algo] = await Promise.all([
    signedRequest<RawOrder[]>(cfg, "GET", "/fapi/v1/openOrders", { symbol }),
    signedRequest<RawAlgoOrder[]>(cfg, "GET", "/fapi/v1/openAlgoOrders", { symbol }).catch(() => []),
  ]);
  /*
   * Shape-checked, not just error-checked.
   *
   * The `.catch` above handles a request that fails. It does not handle one that
   * succeeds and returns something other than a list — which Binance does, on
   * occasion, by answering `{"code":-1130,"msg":...}` with HTTP 200. Mapping
   * over that threw, the throw propagated out of checkProtection, and the caller
   * treated it as "could not check" — so a position missing its stop would keep
   * missing it for as long as the malformed response persisted, which is the
   * exact failure this function exists to prevent.
   */
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return [...list<RawOrder>(plain).map(toOrder), ...list<RawAlgoOrder>(algo).map(fromAlgo)];
}

export async function cancelOrder(
  cfg: BinanceConfig,
  symbol: string,
  orderId: number,
  isAlgo = false,
): Promise<void> {
  if (isAlgo) {
    await signedRequest(cfg, "DELETE", ALGO_PATH, { symbol, algoId: orderId });
    return;
  }
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

  const raw = await signedRequest<RawAlgoOrder>(cfg, "POST", ALGO_PATH, {
    symbol,
    side: long ? "SELL" : "BUY",
    algoType: "CONDITIONAL",
    type: "STOP_MARKET",
    // `triggerPrice` on this endpoint, not `stopPrice` as on the old one.
    triggerPrice: stopPrice.toFixed(pricePrecision),
    closePosition: true,
    workingType: "MARK_PRICE",
  });
  return fromAlgo(raw);
}

/**
 * A resting order that closes the position when it reaches its target.
 *
 * The counterpart to the stop, and its absence was a hole with a cost. The
 * sizer chooses a target, refuses any setup whose target does not justify the
 * risk, and reports the reward-to-risk that follows from it — and then nothing
 * placed an order there. A position that reached its target sat until either the
 * time limit closed it at whatever price had arrived by then, or it round-tripped
 * back through entry and stopped out. Every winner was being held past the point
 * the plan said to take it.
 *
 * Triggered on mark price for the same reason the stop is: last price wicks on a
 * thin book, and a target filled by a print nobody could have traded is not a
 * fill. `closePosition` means Binance sizes the exit itself, so it stays correct
 * if the position was partly closed by something else.
 */
export async function placeTakeProfit(
  cfg: BinanceConfig,
  symbol: string,
  position: Position,
  targetPrice: number,
  pricePrecision: number,
): Promise<Order> {
  if (position.positionAmt === 0) throw new Error("no position to take profit on");
  const long = position.positionAmt > 0;

  // The mirror of the stop's check: a long takes profit above, a short below.
  // Placing one on the wrong side of mark fills instantly at market, which
  // closes the position for a loss the moment it is created.
  if (long && targetPrice <= position.markPrice) {
    throw new Error(`long target ${targetPrice} must be above mark ${position.markPrice}`);
  }
  if (!long && targetPrice >= position.markPrice) {
    throw new Error(`short target ${targetPrice} must be below mark ${position.markPrice}`);
  }

  const raw = await signedRequest<RawAlgoOrder>(cfg, "POST", ALGO_PATH, {
    symbol,
    side: long ? "SELL" : "BUY",
    algoType: "CONDITIONAL",
    type: "TAKE_PROFIT_MARKET",
    triggerPrice: targetPrice.toFixed(pricePrecision),
    closePosition: true,
    workingType: "MARK_PRICE",
  });
  return fromAlgo(raw);
}

/** A resting order that would close this position at a profit. */
export function findTakeProfit(orders: Order[], position: Position): Order | null {
  const long = position.positionAmt > 0;
  const closingSide: Side = long ? "SELL" : "BUY";
  return (
    orders.find(
      (o) =>
        o.side === closingSide &&
        o.type.includes("TAKE_PROFIT") &&
        (o.closePosition || o.reduceOnly) &&
        o.stopPrice > 0,
    ) ?? null
  );
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
  /**
   * The resting order that closes this at its target, when one exists.
   *
   * Separate from `protected`, and deliberately not part of it: a position
   * without a stop is an emergency, a position without a take-profit is only
   * leaving money on the table. Folding the second into the first would make
   * the alarm that means "nothing will stop this losing" fire for something
   * that is merely suboptimal, and an alarm that cries wolf stops working.
   */
  takeProfit: Order | null;
  protected: boolean;
  /** Distance from mark to the stop, percent. Null when unprotected or flat. */
  stopDistancePct: number | null;
  /** Distance from mark to the target, percent. Null when there is no target. */
  targetDistancePct: number | null;
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
    return {
      position: null, stop: null, takeProfit: null, protected: true,
      stopDistancePct: null, targetDistancePct: null, reason: "flat",
    };
  }
  const orders = await listOpenOrders(cfg, symbol);
  const stop = findProtectiveStop(orders, position);
  const takeProfit = findTakeProfit(orders, position);
  const targetDistancePct = takeProfit
    ? Math.abs((takeProfit.stopPrice - position.markPrice) / position.markPrice) * 100
    : null;
  if (!stop) {
    return {
      position,
      stop: null,
      takeProfit,
      protected: false,
      stopDistancePct: null,
      targetDistancePct,
      reason: "OPEN POSITION WITH NO STOP ON THE EXCHANGE — only liquidation would close it",
    };
  }
  const distance = Math.abs((stop.stopPrice - position.markPrice) / position.markPrice) * 100;
  return {
    position,
    stop,
    takeProfit,
    protected: true,
    stopDistancePct: distance,
    targetDistancePct,
    reason:
      `stop resting at ${stop.stopPrice} (${distance.toFixed(2)}% away)` +
      (takeProfit
        ? `, target at ${takeProfit.stopPrice} (${targetDistancePct!.toFixed(2)}% away)`
        : ", no target resting — this closes on the stop or the time limit only"),
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
  /** Where to rest the take-profit, or null when the target is not known. */
  targetPrice: number | null = null,
): Promise<ProtectionState> {
  const state = await checkProtection(cfg, symbol, position);
  if (!state.position) return state;

  const long = state.position.positionAmt > 0;
  const mark = state.position.markPrice;
  const done: string[] = [];

  let stop = state.stop;
  if (!stop) {
    const stopPrice = long ? mark * (1 - stopPct / 100) : mark * (1 + stopPct / 100);
    stop = await placeProtectiveStop(cfg, symbol, state.position, stopPrice, pricePrecision);
    done.push(`placed a protective stop at ${stop.stopPrice} (${stopPct}% from mark)`);
  }

  /*
   * The target, when one is known and none is resting.
   *
   * Attempted after the stop and never instead of it: if the exchange refuses
   * the take-profit the position is still covered, so this reports the failure
   * and carries on rather than unwinding a protected position over a missing
   * exit. The reverse ordering would trade a real safety property for a
   * convenience one.
   */
  let takeProfit = state.takeProfit;
  if (!takeProfit && targetPrice !== null && targetPrice > 0) {
    try {
      takeProfit = await placeTakeProfit(cfg, symbol, state.position, targetPrice, pricePrecision);
      done.push(`target at ${takeProfit.stopPrice}`);
    } catch (err) {
      done.push(`could not place the target: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (done.length === 0) return state;

  const stopDistancePct = Math.abs((stop.stopPrice - mark) / mark) * 100;
  return {
    position: state.position,
    stop,
    takeProfit,
    protected: true,
    stopDistancePct,
    targetDistancePct: takeProfit ? Math.abs((takeProfit.stopPrice - mark) / mark) * 100 : null,
    reason: done.join("; "),
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

export interface PartialClose {
  /** Contracts actually sent, after rounding to the contract's precision. */
  quantity: number;
  /** What is left open afterwards. */
  remaining: number;
  reason: string;
}

/**
 * Take part of a position off at market, leaving the rest running.
 *
 * The mechanism the profit side had no way to express. Every existing exit here
 * is `closePosition: true` — all or nothing — which forces the choice between
 * banking the whole trade at the first target and holding all of it for a tail
 * that may not arrive. Scaling out is the only way to do both, and it needs a
 * sized reduce-only order rather than a position-level one.
 *
 * Two refusals matter more than the happy path:
 *
 * The remainder must stay tradeable. Reducing to a quantity below the
 * contract's step size leaves a position that cannot be closed by a normal
 * order, and the protective stop resting behind it is `closePosition`-based, so
 * the position would sit there until something manual happened to it. Better to
 * take nothing.
 *
 * And it never flips. `reduceOnly` is set on the exchange side as well as
 * checked here, because a rounding error that sends more contracts than are
 * open would otherwise open a fresh position in the opposite direction — a
 * profit-taking routine that can accidentally reverse the trade is worse than
 * no profit-taking routine.
 */
export async function reducePosition(
  cfg: BinanceConfig,
  symbol: string,
  fraction: number,
  quantityPrecision: number,
): Promise<PartialClose> {
  const rows = await signedRequest<{ positionAmt: string }[]>(cfg, "GET", "/fapi/v2/positionRisk", { symbol });
  const raw = rows.find((r) => Number(r.positionAmt) !== 0);
  if (!raw) return { quantity: 0, remaining: 0, reason: "flat — nothing to reduce" };

  const amt = num(raw.positionAmt);
  const open = Math.abs(amt);
  const step = Math.pow(10, -quantityPrecision);

  const wanted = open * Math.min(Math.max(fraction, 0), 0.9);
  const quantity = Number((Math.floor(wanted / step) * step).toFixed(quantityPrecision));

  if (!(quantity > 0)) {
    return { quantity: 0, remaining: open, reason: `${(fraction * 100).toFixed(0)}% of ${open} rounds to nothing at this contract's precision` };
  }
  const remaining = Number((open - quantity).toFixed(quantityPrecision));
  if (remaining < step) {
    return {
      quantity: 0,
      remaining: open,
      reason:
        `taking ${quantity} of ${open} would leave ${remaining}, below the ${step} step — the remainder ` +
        `could not be closed normally, so nothing was taken`,
    };
  }

  await signedRequest(cfg, "POST", "/fapi/v1/order", {
    symbol,
    side: amt > 0 ? "SELL" : "BUY",
    type: "MARKET",
    quantity: quantity.toFixed(quantityPrecision),
    reduceOnly: true,
  });
  return { quantity, remaining, reason: `took ${quantity} of ${open}, ${remaining} still running` };
}

/**
 * Rest a reduce-only limit order to close the whole position at a chosen price.
 *
 * The market close answers "get me out now". This answers the other question an
 * operator actually has, which is "get me out *there*" — a level they have a
 * view about, without paying the spread to express it and without sitting on the
 * screen waiting to press a button.
 *
 * `reduceOnly` is what makes it safe to leave resting next to the automatic
 * bracket. The protective stop is a position-level order and this is not, so in
 * principle both could fill; reduceOnly means the second one to arrive closes
 * nothing rather than opening a position the other way. That is the difference
 * between a redundant order and an accidental reversal.
 *
 * Priced through the market on purpose when the operator asks for it. A limit to
 * sell below the bid is a marketable order and will fill immediately at the
 * touch — that is a legitimate thing to want (a controlled exit with a worst
 * acceptable price, rather than whatever the book offers), so it is reported
 * rather than refused.
 */
export interface LimitClose {
  orderId: number;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  /** True when the price is already through the market and will fill at once. */
  marketable: boolean;
  reason: string;
}

export async function closePositionAtLimit(
  cfg: BinanceConfig,
  symbol: string,
  price: number,
  quantityPrecision: number,
  pricePrecision: number,
): Promise<LimitClose> {
  if (!(price > 0)) throw new Error("a limit price above zero is required");

  const rows = await signedRequest<{ positionAmt: string }[]>(cfg, "GET", "/fapi/v2/positionRisk", { symbol });
  const raw = rows.find((r) => Number(r.positionAmt) !== 0);
  if (!raw) throw new Error("flat — there is no position to close");

  const amt = num(raw.positionAmt);
  const open = Math.abs(amt);
  const long = amt > 0;
  const side: "BUY" | "SELL" = long ? "SELL" : "BUY";

  const step = Math.pow(10, -quantityPrecision);
  const quantity = Number((Math.floor(open / step) * step).toFixed(quantityPrecision));
  if (!(quantity > 0)) throw new Error(`a position of ${open} rounds to nothing at this contract's precision`);

  const limitPrice = Number(price.toFixed(pricePrecision));

  /*
   * Which side of the book it lands on, reported rather than assumed.
   *
   * A closing sell above the ask rests and waits; below the bid it crosses. The
   * operator may want either, but they should be told which one they just did —
   * "I set a limit" and "I paid the spread" feel like different actions and the
   * order behaves like whichever the price implies.
   */
  const book = await signedRequest<{ bidPrice: string; askPrice: string }>(
    cfg, "GET", "/fapi/v1/ticker/bookTicker", { symbol },
  ).catch(() => null);
  const bid = book ? num(book.bidPrice) : 0;
  const ask = book ? num(book.askPrice) : 0;
  const marketable = side === "SELL" ? bid > 0 && limitPrice <= bid : ask > 0 && limitPrice >= ask;

  const res = await signedRequest<{ orderId: number }>(cfg, "POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "LIMIT",
    // Good-till-cancel: the whole point is that it waits. A post-only variant
    // would be rejected outright whenever the price is through the market,
    // which is a case this deliberately supports.
    timeInForce: "GTC",
    quantity: quantity.toFixed(quantityPrecision),
    price: limitPrice.toFixed(pricePrecision),
    reduceOnly: true,
  });

  return {
    orderId: res.orderId,
    side,
    quantity,
    price: limitPrice,
    marketable,
    reason: marketable
      ? `${side} ${quantity} at ${limitPrice} is through the market — it will fill immediately at the touch`
      : `${side} ${quantity} resting at ${limitPrice}, waiting. The protective stop is untouched.`,
  };
}

/* ------------------------------------------------------------- exit proving */

export interface ExitTestStep {
  at: number;
  text: string;
}

export interface ExitTestResult {
  ok: boolean;
  /** Which bracket actually closed the position, when one did. */
  closedBy: "stop" | "target" | "timeout-manual" | "none";
  entryPrice: number;
  exitPrice: number | null;
  stopPrice: number;
  targetPrice: number;
  /** Realised gap between the trigger price and the fill, in basis points. */
  slippageBps: number | null;
  steps: ExitTestStep[];
}

/**
 * Prove that a stop and a take-profit actually fire.
 *
 * Placing a conditional order and having it trigger are different claims, and
 * only the first has ever been observed here. The stop resting on the exchange
 * is the property the whole design leans on — positions are deliberately left
 * open on shutdown because the stop survives this process — and that property
 * had never once been tested end to end. A stop that rests but does not trigger
 * looks identical in every readout to one that works.
 *
 * So this opens a deliberately small position with both brackets placed
 * unusually close to mark, and waits for the market to take one of them. It is
 * not a simulation and not a dry run: real orders, real triggers, real fills.
 * The tight brackets are the whole point — at ordinary distances the test would
 * take hours and prove nothing about the mechanism.
 *
 * What it reports is the thing worth knowing: which bracket fired, how long it
 * took, and how far the fill landed from the trigger. That last number is the
 * one that does not appear anywhere else, and it is the difference between a
 * stop that bounds a loss and a stop that merely gestures at one.
 *
 * Fails closed. If neither bracket fires inside the timeout the position is
 * closed at market and reported as inconclusive, because a test that leaves an
 * open position behind is worse than no test.
 */
export async function testExitPath(
  cfg: BinanceConfig,
  symbol: string,
  side: Side,
  quantity: string,
  bracketPct: number,
  pricePrecision: number,
  timeoutMs = 5 * 60_000,
): Promise<ExitTestResult> {
  const steps: ExitTestStep[] = [];
  const note = (text: string) => steps.push({ at: Date.now(), text });

  const entry = toOrder(
    await signedRequest<RawOrder>(cfg, "POST", "/fapi/v1/order", { symbol, side, type: "MARKET", quantity }),
  );
  note(`entry filled: ${side} ${quantity} ${symbol}`);

  let position = await fetchPosition(cfg, symbol);
  if (!position) {
    note("entry reported filled but no position exists — nothing to test");
    return {
      ok: false, closedBy: "none", entryPrice: entry.avgPrice, exitPrice: null,
      stopPrice: 0, targetPrice: 0, slippageBps: null, steps,
    };
  }

  const long = position.positionAmt > 0;
  const mark = position.markPrice;
  const stopPrice = long ? mark * (1 - bracketPct / 100) : mark * (1 + bracketPct / 100);
  const targetPrice = long ? mark * (1 + bracketPct / 100) : mark * (1 - bracketPct / 100);

  let stop: Order;
  try {
    stop = await placeProtectiveStop(cfg, symbol, position, stopPrice, pricePrecision);
    note(`stop resting at ${stop.stopPrice}`);
  } catch (err) {
    // The position is naked, so it goes now rather than staying open while a
    // test result is assembled.
    note(`stop REJECTED: ${err instanceof Error ? err.message : String(err)} — closing the position`);
    await closePosition(cfg, symbol);
    return {
      ok: false, closedBy: "none", entryPrice: position.entryPrice, exitPrice: null,
      stopPrice, targetPrice, slippageBps: null, steps,
    };
  }

  let target: Order | null = null;
  try {
    target = await placeTakeProfit(cfg, symbol, position, targetPrice, pricePrecision);
    note(`target resting at ${target.stopPrice}`);
  } catch (err) {
    note(`target REJECTED: ${err instanceof Error ? err.message : String(err)} — the stop still stands`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3_000);
    position = await fetchPosition(cfg, symbol);
    if (position && position.positionAmt !== 0) continue;

    // Flat. Which bracket did it, and at what price — read from the trade
    // ledger rather than inferred, because inferring it from the last mark is
    // how a stop that filled 40bp away gets recorded as having filled at its
    // trigger.
    const fills = await signedRequest<{ price: string; qty: string; time: number; side: string }[]>(
      cfg, "GET", "/fapi/v1/userTrades", { symbol, limit: 20 },
    ).catch(() => []);
    const closing = fills.filter((f) => f.side !== side).sort((a, b) => b.time - a.time)[0];
    const exitPrice = closing ? num(closing.price) : null;
    const nearer =
      exitPrice === null
        ? null
        : Math.abs(exitPrice - stopPrice) <= Math.abs(exitPrice - targetPrice)
          ? ("stop" as const)
          : ("target" as const);
    const trigger = nearer === "stop" ? stopPrice : targetPrice;
    const slippageBps =
      exitPrice !== null && trigger > 0 ? ((exitPrice - trigger) / trigger) * 10_000 : null;
    note(
      `position closed by the ${nearer ?? "exchange"}` +
        (exitPrice !== null ? ` at ${exitPrice} (trigger ${trigger.toFixed(pricePrecision)})` : ""),
    );

    // Whichever one did not fire is still resting and would open a new position
    // in the opposite direction if it triggered later. closePosition orders are
    // cancelled automatically by Binance, but not instantly, and not verifying
    // that is how a test leaves a live order behind.
    for (const o of await listOpenOrders(cfg, symbol)) {
      await cancelOrder(cfg, symbol, o.orderId, o.isAlgo).catch(() => {});
      note(`cancelled the leftover ${o.type}`);
    }

    return {
      ok: nearer !== null,
      closedBy: nearer ?? "none",
      entryPrice: entry.avgPrice || 0,
      exitPrice,
      stopPrice,
      targetPrice,
      slippageBps,
      steps,
    };
  }

  note(`neither bracket fired within ${Math.round(timeoutMs / 60_000)} min — closing at market`);
  await closePosition(cfg, symbol);
  for (const o of await listOpenOrders(cfg, symbol)) {
    await cancelOrder(cfg, symbol, o.orderId, o.isAlgo).catch(() => {});
  }
  return {
    ok: false, closedBy: "timeout-manual", entryPrice: entry.avgPrice || 0, exitPrice: null,
    stopPrice, targetPrice, slippageBps: null, steps,
  };
}
