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
import { classifyConstraint, type ConstraintEvent } from "./constraints";

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
  /**
   * Share of free collateral held back rather than committed, in percent.
   *
   * The direct cause of "-2019 Margin is insufficient", and the reason this
   * exists as a dial rather than a constant. Sizing used the whole available
   * balance as margin: `notional = equity × leverage` is by definition the most
   * the account can fund, so any position at that boundary rejects, because the
   * opening commission comes out of the same balance and Binance rounds initial
   * margin up at the applied leverage. The order was not slightly too large, it
   * was exactly too large — and every attempt at maximum size failed for a few
   * dollars of fee.
   *
   * The right amount of headroom is account-specific: it depends on the fee
   * tier, on whether a leverage bracket quietly reduces the applied leverage,
   * and on unrealised PnL moving the free balance between the read and the
   * order. So it starts small and the constraint loop raises it when the venue
   * says it is still not enough.
   */
  marginHeadroomPct: number;
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
  /**
   * Every venue rejection, classified, so the constraint loop can count them.
   *
   * Fired for the attempts that were retried as well as the one that finally
   * failed, because a margin rejection that a smaller retry rescued is still
   * evidence the sizing is calibrated too close to the edge — arguably the
   * clearest evidence there is, since it says so without costing a trade.
   */
  onConstraint?: (event: ConstraintEvent) => void;
  /**
   * The venue says nothing will work until something changes outside this
   * process. Scope is "symbol" for a per-contract permission and "all" for a
   * key, a clock or a ban.
   */
  onHalt?: (scope: "halt-symbol" | "halt-all", symbol: string, reason: string) => void;
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

      /*
       * One attempt, plus whatever the constraint table allows.
       *
       * The retry loop lives outside the body rather than around the HTTP call
       * because most of what has to change on a retry is decided before the
       * request: the size, the leverage, the precision. Retrying at the call
       * site could only re-send the same bytes, which for every code in the
       * table is either pointless or harmful.
       */
      let sizeScale = 1;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++;
        const outcome = await attemptSubmit(intent, state, sizeScale, attempt);
        if (outcome.done) return;
        sizeScale = outcome.nextScale;
        // A pause before a retry that asked for one, so a rate limit is not
        // answered by immediately spending another request against it.
        if (outcome.waitMs > 0) await new Promise((r) => setTimeout(r, outcome.waitMs));
      }
    },
  };

  /**
   * A single attempt, returning what the caller should do next.
   *
   * Split out so the retry policy is readable in one place and cannot
   * accidentally re-enter the interlocks with stale numbers — every attempt
   * re-reads limits, balance and position from the exchange, which is the whole
   * reason a retry is safe at all.
   */
  async function attemptSubmit(
    intent: TradeIntent,
    state: AgentState,
    sizeScale: number,
    attempt: number,
  ): Promise<{ done: true } | { done: false; nextScale: number; waitMs: number }> {
    const { cfg, symbol } = options;
    const limits = options.limits();

    {
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

        /*
         * Size against what can actually be committed, not the whole balance.
         *
         * See marginHeadroomPct. The sizer's affordability ceiling is
         * `equity × leverage`, which is the exact maximum the account can fund
         * and therefore fails as soon as the opening commission is taken from
         * the same balance. Holding a slice back turns "exactly too large" into
         * "comfortably fundable" without changing anything about how risk is
         * computed — the risk budget is a fraction of equity either way.
         */
        /*
         * Coerced, because a missing value here silently voided the leverage cap.
         *
         * `Math.max(0, undefined)` is NaN, so an absent marginHeadroomPct made
         * `committable` NaN, which made `impliedLeverage` NaN, and `NaN > cap`
         * is false — the ceiling below stopped refusing anything at all while
         * still appearing in the code and in the GUI. An operator upgrading with
         * a limits file written before this field existed would have got exactly
         * that, and the first sign of it would have been a filled order at a
         * leverage they had explicitly capped.
         *
         * Not defensive programming for its own sake: this is the one place that
         * enforces an account-wide cap on real money, so it has to fail closed
         * on a bad input rather than compute its way past one.
         */
        const headroomPct = Number.isFinite(limits.marginHeadroomPct) ? limits.marginHeadroomPct : 5;
        const headroom = Math.min(50, Math.max(0, headroomPct)) / 100;
        const committable = risk.availableBalance * (1 - headroom);
        if (!Number.isFinite(committable) || committable <= 0) {
          throw new Refused(
            `available balance reads ${String(risk.availableBalance)} — cannot size against that`,
          );
        }

        const sized = options.size(intent, state, committable);
        if (!sized) throw new Refused("sizing declined this setup");

        /*
         * The cap is a ceiling on the sizer, and zero means there is no ceiling.
         *
         * It used to mean "refuse everything", which made a single blank field
         * the most destructive setting in the program: every order was rejected
         * before the strategy was consulted, the log filled with per-order
         * refusals rather than one clear statement, and a session could be dead
         * for hours. Nothing an operator can type into a box should be able to
         * do that.
         *
         * Zero is now consistent with every other cap here — maxDailyLossUsd,
         * maxTradesPerDay, lossCooldownMin all already mean "no limit" at zero —
         * and it is safe, because size is never actually unbounded: the risk
         * budget sets it, and the leverage ceiling and the margin check below
         * both still apply.
         */
        let notional = limits.maxPositionUsd > 0
          ? Math.min(sized.notionalUsd, limits.maxPositionUsd)
          : sized.notionalUsd;
        if (notional <= 0) throw new Refused("the sizer returned nothing to trade");
        // Applied by the caller when a rejection asked for a smaller order.
        notional *= sizeScale;

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
        /*
         * Leverage derived from the committable balance too.
         *
         * Against the raw balance this rounds down: a notional that needs 10.0x
         * of everything needs 10.5x of what is actually spendable, and `ceil`
         * of the wrong ratio hands back a leverage whose margin requirement the
         * account cannot meet. That mismatch is the -2019 arriving from the
         * other direction, and fixing only the sizer would have left it.
         */
        const impliedLeverage = actualNotional / Math.max(committable, 1e-9);
        // `!(x <= cap)` rather than `x > cap`, so a NaN that survived everything
        // above refuses instead of passing. The comparison that reads more
        // naturally is the one that fails open.
        if (!(impliedLeverage <= limits.maxLeverage)) {
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
            return { done: true };
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
          return { done: true };
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
        return { done: true };
      } catch (err) {
        const refused = err instanceof Refused;
        const detail = err instanceof Error ? err.message : String(err);

        /*
         * A Refused is our own decision and never a venue constraint, so it is
         * never classified and never retried. Conflating the two would send the
         * daily loss cap through the retry machinery and shrink the order until
         * it squeezed past a limit that exists precisely to stop the trade.
         */
        if (refused) {
          record({ at: Date.now(), intentId: intent.id, outcome: "refused", detail });
          return { done: true };
        }

        const c = classifyConstraint(err);
        options.onConstraint?.({ at: Date.now(), symbol, kind: c.kind, code: c.code, detail });

        const canRetry = attempt < c.maxAttempts;
        const retryable =
          c.immediate === "retry-smaller" || c.immediate === "retry-later" || c.immediate === "retry-rounded";

        if (canRetry && retryable) {
          const nextScale = c.immediate === "retry-smaller" ? sizeScale * (c.retryScale ?? 0.66) : sizeScale;
          record({
            at: Date.now(),
            intentId: intent.id,
            // Not "failed": the order is still in flight as far as this loop is
            // concerned, and marking it failed would put a permanent error in
            // the history for something about to succeed.
            outcome: "refused",
            detail:
              `${detail}\n    → ${c.explain}\n    → retrying (attempt ${attempt + 1} of ${c.maxAttempts})` +
              (c.immediate === "retry-smaller" ? ` at ${(nextScale * 100).toFixed(0)}% of the sized position` : ""),
          });
          // Rate limits and 5xx get a real pause; a resize does not need one.
          return { done: false, nextScale, waitMs: c.immediate === "retry-later" ? 2_000 * attempt : 0 };
        }

        record({
          at: Date.now(),
          intentId: intent.id,
          outcome: "failed",
          detail:
            `${detail}\n    → ${c.explain}` +
            (c.operatorAction ? `\n    → ${c.operatorAction}` : "") +
            (attempt > 1 ? `\n    → gave up after ${attempt} attempts` : ""),
        });

        // Halts are the venue saying nothing will work until something changes
        // outside this process, and they are reported to the caller rather than
        // thrown, so one unsigned agreement does not read as a crash.
        if (c.immediate === "halt-symbol" || c.immediate === "halt-all") {
          options.onHalt?.(c.immediate, symbol, `${c.explain}${c.operatorAction ? ` ${c.operatorAction}` : ""}`);
          return { done: true };
        }

        // Everything else stays loud: something went wrong mid-flight and
        // openProtectedPosition may have already unwound a position.
        throw new Error(`order failed: ${detail}`);
      }
    }
  }
}

/** Close everything and cancel resting orders. The panic path. */
export async function flatten(cfg: BinanceConfig, symbol: string): Promise<string> {
  const position = await fetchPosition(cfg, symbol);
  if (!position) return "already flat";
  await closePosition(cfg, symbol);
  return `closed ${position.positionAmt} ${symbol} at market`;
}
