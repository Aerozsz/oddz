import type { AgentState, ExecutionAdapter, TradeIntent } from "../agent/types";
import { fetchDayActivity, dayDrawdown } from "./activity";
import { fetchAccountRisk, fetchPosition, type BinanceConfig } from "./binance";
import { closePosition, openProtectedPosition, type Order } from "./orders";

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
  quantityPrecision?: number;
  pricePrecision?: number;
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

        const notional = Math.min(intent.reference.mid > 0 ? limits.maxPositionUsd : 0, limits.maxPositionUsd);
        if (notional <= 0) throw new Refused("max position size is not set");

        const rawQty = notional / mid;
        const quantity = Number(rawQty.toFixed(qtyPrecision));
        if (!(quantity > 0)) {
          throw new Refused(`size rounds to zero at ${qtyPrecision} decimals`);
        }

        const impliedLeverage = notional / Math.max(risk.availableBalance, 1e-9);
        if (impliedLeverage > limits.maxLeverage) {
          throw new Refused(
            `would need ${impliedLeverage.toFixed(1)}x against a ${limits.maxLeverage}x ceiling`,
          );
        }

        /* ------------------------------------------------------------ submit */

        const side = intent.side === "buy" ? "BUY" : "SELL";
        const { entry, stop } = await openProtectedPosition(
          cfg,
          symbol,
          side,
          quantity.toFixed(qtyPrecision),
          limits.stopLossPct,
          pricePrecision,
        );

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
