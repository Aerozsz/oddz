import type { AgentState, ExecutionAdapter, TradeIntent } from "../agent/types";
import { fetchDayActivity, dayDrawdown } from "./activity";
import { fetchAccountRisk, fetchPosition, type BinanceConfig } from "./binance";
import {
  closePosition,
  openProtectedMakerPosition,
  openProtectedPosition,
  setLeverage,
  type MakerEntryOptions,
  type Order,
} from "./orders";

/**
 * The adapter that actually sends an order.
 *
 * Everything above this point can be wrong without costing anything. This is
 * the boundary where a mistake becomes money, so the checks here are
 * deliberately redundant with the ones upstream: the sizer already refuses on
 * the daily loss cap, and this refuses again on its own reading of it. Upstream
 * state can be stale, cached, or computed from a snapshot taken seconds ago.
 * The check that matters is the one made against the exchange immediately
 * before the order goes out.
 *
 * Nothing here decides *whether* to trade. It is handed an intent and its only
 * job is to refuse it or execute it exactly.
 */

export interface AdapterLimits {
  maxPositionUsd: number;
  maxLeverage: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  lossCooldownMin: number;
  stopLossPct: number;
  tradingEnabled: boolean;
}

export interface ExecutionRecord {
  at: number;
  intentId: string;
  outcome: "submitted" | "refused" | "failed";
  detail: string;
  entry?: Order;
  stop?: Order;
}

export interface BinanceAdapterOptions {
  cfg: BinanceConfig;
  symbol: string;
  /** Read fresh on every submit rather than captured, so edits take effect at once. */
  limits: () => AdapterLimits;
  /**
   * How big, and where the stop goes.
   *
   * This exists because the adapter previously derived size as
   * `limits.maxPositionUsd` — every order was the maximum allowed, and all of
   * the sizer's work (risk-based sizing, stop placement beyond the crowd,
   * session scaling, the depth-share cap, the fee and funding checks) informed
   * only *whether* to trade, never *how much*. At a 100 position cap that is
   * invisible; at a real one it means the careful arithmetic upstream was
   * decoration and every trade was maximum exposure.
   *
   * TradeIntent deliberately carries no quantity — sizing needs account state
   * the strategy layer has no business seeing — so it arrives here instead.
   * Return null to refuse.
   */
  size: (
    intent: TradeIntent,
    state: AgentState,
    availableBalance: number,
  ) => { notionalUsd: number; stopPct: number; leverage: number; reason: string } | null;
  quantityPrecision?: number;
  pricePrecision?: number;
  /**
   * Try to rest the entry on the book instead of crossing.
   *
   * Worth roughly 3bp of a 10bp round trip, which against a target 30-50bp
   * away is a fifth to a third of net return. The cost is that it sometimes
   * does not fill — which is not a loss, it is the trade not happening, and a
   * missed entry is cheaper than a bad fill. Returns null to fall back to a
   * market order; supply a price and the maker path is used.
   */
  makerEntryPrice?: (side: "BUY" | "SELL") => number | null;
  makerEntry?: Partial<MakerEntryOptions>;
  /**
   * Called with every fill so execution quality can be measured.
   *
   * Without this the maker path is an unverified claim: the whole argument for
   * resting an entry is that it costs 3bp less, and nothing would have checked
   * whether the fills actually came in where the model said, or whether the
   * ones that did fill were the ones we would rather have missed. `arrivalMid`
   * is the mid at the moment of the decision, so slippage is measured against
   * what was seen rather than against the fill itself.
   */
  onFill?: (fill: {
    t: number;
    side: "buy" | "sell";
    price: number;
    notional: number;
    arrivalMid: number | null;
    tag: string;
  }) => void;
  onRecord?: (record: ExecutionRecord) => void;
}

class Refused extends Error {}

export function createBinanceAdapter(options: BinanceAdapterOptions): ExecutionAdapter & {
  history: ExecutionRecord[];
} {
  const history: ExecutionRecord[] = [];
  const qtyPrecision = options.quantityPrecision ?? 0;
  const pricePrecision = options.pricePrecision ?? 2;

  const record = (r: ExecutionRecord) => {
    history.unshift(r);
    if (history.length > 200) history.length = 200;
    options.onRecord?.(r);
  };

  return {
    name: `binance-${options.cfg.live ? "LIVE" : "testnet"}`,
    history,

    async submit(intent: TradeIntent, state: AgentState) {
      const { cfg, symbol } = options;
      const limits = options.limits();

      try {
        /* ---------------------------------------------------- the interlocks */

        if (!limits.tradingEnabled) {
          throw new Refused("trading is disarmed");
        }
        if (!state.health.tradeable) {
          throw new Refused(`feed not tradeable: ${state.health.summary}`);
        }

        // Read from the exchange, now. Everything below is checked against what
        // the account actually is rather than what a snapshot said it was.
        const [risk, position, activity] = await Promise.all([
          fetchAccountRisk(cfg),
          fetchPosition(cfg, symbol),
          fetchDayActivity(cfg, symbol),
        ]);

        if (position) {
          throw new Refused(
            `already holding ${position.positionAmt} ${symbol} — this adapter opens, it does not add`,
          );
        }
        if (risk.openPositions.length >= limits.maxOpenPositions) {
          throw new Refused(`at the ${limits.maxOpenPositions}-position limit`);
        }

        const drawdown = dayDrawdown(activity);
        if (limits.maxDailyLossUsd > 0 && drawdown >= limits.maxDailyLossUsd) {
          throw new Refused(
            `daily loss cap: ${drawdown.toFixed(2)} lost of ${limits.maxDailyLossUsd} allowed (fees and funding included)`,
          );
        }
        if (limits.maxTradesPerDay > 0 && activity.trades >= limits.maxTradesPerDay) {
          throw new Refused(`${activity.trades} trades today, cap is ${limits.maxTradesPerDay}`);
        }
        if (limits.lossCooldownMin > 0 && activity.lastLossAt > 0) {
          const elapsedMin = (Date.now() - activity.lastLossAt) / 60_000;
          if (elapsedMin < limits.lossCooldownMin) {
            throw new Refused(
              `cooling off — ${Math.ceil(limits.lossCooldownMin - elapsedMin)} of ${limits.lossCooldownMin} min left since the last loss`,
            );
          }
        }

        /* ----------------------------------------------------------- sizing */

        const mid = state.mid;
        if (!mid || mid <= 0) throw new Refused("no price to size against");

        const sized = options.size(intent, state, risk.availableBalance);
        if (!sized) throw new Refused("sizing declined this setup");

        // The cap is a ceiling on the sizer, not the size itself.
        const notional = Math.min(sized.notionalUsd, limits.maxPositionUsd);
        if (notional <= 0) throw new Refused("max position size is not set");

        const rawQty = notional / mid;
        const quantity = Number(rawQty.toFixed(qtyPrecision));
        if (!(quantity > 0)) {
          // The common case on a small account: one contract of this symbol is
          // worth more than the whole sized position. Naming both numbers saves
          // a long hunt through the sizer for a refusal that is really about
          // the contract, not the strategy.
          throw new Refused(
            `sized position is ${notional.toFixed(2)} but one contract costs about ${mid.toFixed(2)} — ` +
              `rounds to zero at ${qtyPrecision} decimals. The account is too small for this symbol at this risk setting.`,
          );
        }

        // Re-derive from what will actually be traded, since rounding to whole
        // contracts can push the notional above what was sized.
        const actualNotional = quantity * mid;
        const impliedLeverage = actualNotional / Math.max(risk.availableBalance, 1e-9);
        if (impliedLeverage > limits.maxLeverage) {
          throw new Refused(
            `${quantity} contract${quantity === 1 ? "" : "s"} is ${actualNotional.toFixed(2)} of notional, ` +
              `which needs ${impliedLeverage.toFixed(1)}x against a ${limits.maxLeverage}x ceiling`,
          );
        }

        // Send the leverage before the order. Without this the position opens at
        // whatever the account was last set to in the Binance UI, and every
        // margin and liquidation figure shown upstream is wrong.
        const leverage = Math.min(limits.maxLeverage, Math.max(1, Math.ceil(impliedLeverage)));
        await setLeverage(cfg, symbol, leverage);

        /* ------------------------------------------------------------ submit */

        const side = intent.side === "buy" ? "BUY" : "SELL";
        const makerPrice = options.makerEntryPrice?.(side) ?? null;

        if (makerPrice !== null && makerPrice > 0) {
          const { entry, stop } = await openProtectedMakerPosition(
            cfg,
            symbol,
            side,
            quantity.toFixed(qtyPrecision),
            makerPrice.toFixed(pricePrecision),
            limits.stopLossPct,
            pricePrecision,
            options.makerEntry,
          );

          // Nothing filled is a normal outcome for a resting order and must not
          // read as an error. It is the trade not happening, which is the price
          // of not crossing the spread and is cheaper than a bad fill.
          if (entry.filledQty <= 0) {
            record({
              at: Date.now(),
              intentId: intent.id,
              outcome: "refused",
              detail: `no position opened — ${entry.reason}`,
            });
            return;
          }

          options.onFill?.({
            t: Date.now(),
            side: intent.side,
            price: entry.avgPrice,
            notional: entry.filledQty * entry.avgPrice,
            arrivalMid: state.mid,
            tag: `maker:${entry.outcome}`,
          });

          record({
            at: Date.now(),
            intentId: intent.id,
            outcome: "submitted",
            detail:
              `${side} ${entry.filledQty} ${symbol} resting at ${makerPrice.toFixed(pricePrecision)} ` +
              `(maker, filled at ${entry.avgPrice})` +
              (entry.outcome === "partial" ? ` — PARTIAL, ${quantity} was intended` : "") +
              `, protective stop resting at ${stop?.stopPrice ?? "—"}. Reason: ${intent.reason}`,
            entry: entry.order ?? undefined,
            stop: stop ?? undefined,
          });
          return;
        }

        const { entry, stop } = await openProtectedPosition(
          cfg,
          symbol,
          side,
          quantity.toFixed(qtyPrecision),
          sized.stopPct,
          pricePrecision,
        );

        const filled = await fetchPosition(cfg, symbol);
        options.onFill?.({
          t: Date.now(),
          side: intent.side,
          price: filled?.entryPrice ?? state.mid ?? 0,
          notional,
          arrivalMid: state.mid,
          tag: "taker",
        });

        record({
          at: Date.now(),
          intentId: intent.id,
          outcome: "submitted",
          detail:
            `${side} ${quantity} ${symbol} at market (~${notional.toFixed(0)} notional), ` +
            `protective stop resting at ${stop.stopPrice}. Reason: ${intent.reason}`,
          entry,
          stop,
        });
      } catch (err) {
        const refused = err instanceof Refused;
        const detail = err instanceof Error ? err.message : String(err);
        record({
          at: Date.now(),
          intentId: intent.id,
          outcome: refused ? "refused" : "failed",
          detail,
        });
        // A refusal is a normal outcome and stays quiet. A failure is not:
        // something went wrong mid-flight and openProtectedPosition may have
        // already unwound a position, which the operator needs to see.
        if (!refused) throw new Error(`order failed: ${detail}`);
      }
    },
  };
}

/** Close everything and cancel resting orders. The panic path. */
export async function flatten(cfg: BinanceConfig, symbol: string): Promise<string> {
  const position = await fetchPosition(cfg, symbol);
  if (!position) return "already flat";
  await closePosition(cfg, symbol);
  return `closed ${position.positionAmt} ${symbol} at market`;
}
