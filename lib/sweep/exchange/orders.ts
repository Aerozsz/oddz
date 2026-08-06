import { signedRequest, type BinanceConfig, type Position } from "./binance";

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
