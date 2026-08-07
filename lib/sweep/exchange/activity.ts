import { signedRequest, type BinanceConfig } from "./binance";

/**
 * What has already happened today, read from the exchange.
 *
 * The daily loss cap, the trade ceiling and the post-loss cooldown all depend
 * on knowing what today has already cost. Keeping that in process memory would
 * mean a restart wipes it — and a restart is exactly when a run of losses is
 * most likely to have just happened. Worse, the counter would reset to zero at
 * the moment the limits matter most, so a bad session could be laundered into a
 * fresh one by stopping and starting.
 *
 * Binance's income ledger is the authority instead. It survives restarts, it
 * cannot be talked out of what it recorded, and it is the same source that
 * settled the money.
 */

export interface DayActivity {
  /** Realised profit and loss since UTC midnight. Negative is a loss. */
  realisedPnl: number;
  /** Losses only, as a positive number — what the daily cap is measured against. */
  realisedLoss: number;
  /** Closed trades today. */
  trades: number;
  /** When the last losing trade settled, epoch ms. 0 if there has not been one. */
  lastLossAt: number;
  /** Fees and funding paid today, which the raw PnL figure excludes. */
  fees: number;
  funding: number;
  /** Start of the day this covers, epoch ms. */
  since: number;
}

interface RawIncome {
  symbol: string;
  incomeType: string;
  income: string;
  time: number;
}

/** UTC midnight, matching how Binance buckets its own daily figures. */
export function startOfDayUtc(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function fetchDayActivity(
  cfg: BinanceConfig,
  symbol: string,
  now = Date.now(),
): Promise<DayActivity> {
  const since = startOfDayUtc(now);
  const rows = await signedRequest<RawIncome[]>(cfg, "GET", "/fapi/v1/income", {
    symbol,
    startTime: since,
    limit: 1000,
  });

  let realisedPnl = 0;
  let realisedLoss = 0;
  let trades = 0;
  let lastLossAt = 0;
  let fees = 0;
  let funding = 0;

  for (const row of rows) {
    const amount = Number(row.income);
    if (!Number.isFinite(amount)) continue;

    switch (row.incomeType) {
      case "REALIZED_PNL":
        realisedPnl += amount;
        trades++;
        if (amount < 0) {
          realisedLoss += -amount;
          // Rows are not guaranteed ordered, so take the latest rather than the last.
          if (row.time > lastLossAt) lastLossAt = row.time;
        }
        break;
      case "COMMISSION":
        fees += -amount;
        break;
      case "FUNDING_FEE":
        funding += -amount;
        break;
    }
  }

  return { realisedPnl, realisedLoss, trades, lastLossAt, fees, funding, since };
}

/**
 * What one closed position actually settled for.
 *
 * The post-mortem needs the exit price, the realised PnL and the fees for a
 * single trade, and none of the three is derivable from anything this process
 * saw. The mark price at the moment the position was noticed flat is not the
 * exit price — the stop that closed it triggered at a level and filled at
 * another, and on this strategy the difference between those two is a
 * meaningful share of the trade. Asking the exchange what it settled is the
 * only answer that is not a guess.
 *
 * Attribution is by time window, which is exact here for one reason worth
 * stating: the concurrency guard allows one position per symbol at a time, so
 * everything the ledger reports for this symbol between the open and the close
 * belongs to this trade. Remove that guard and this becomes a sum over
 * overlapping trades that still returns a plausible number, which is the
 * dangerous kind of wrong.
 *
 * Commission is summed over the whole window rather than the closing fills, so
 * it covers the round trip — the entry fee is part of what the trade cost even
 * though it was paid before the trade was over.
 */
export interface Settlement {
  /** Gross realised PnL, before commission and funding. */
  realisedPnl: number;
  /** Commission on both legs. Positive is a cost. */
  fees: number;
  /** Funding paid or received while the position was held. Positive is a cost. */
  funding: number;
  /** Quantity-weighted average price of the fills that reduced the position. */
  exitPrice: number | null;
  /** How many fills the window covered, so a thin answer is recognisable. */
  fills: number;
  /** True when the exchange returned nothing — the caller should retry, not record. */
  empty: boolean;
}

interface RawUserTrade {
  symbol: string;
  price: string;
  qty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

export async function fetchSettlement(
  cfg: BinanceConfig,
  symbol: string,
  since: number,
  until = Date.now(),
): Promise<Settlement> {
  const [trades, income] = await Promise.all([
    signedRequest<RawUserTrade[]>(cfg, "GET", "/fapi/v1/userTrades", {
      symbol,
      startTime: since,
      endTime: until,
      limit: 1000,
    }),
    signedRequest<RawIncome[]>(cfg, "GET", "/fapi/v1/income", {
      symbol,
      incomeType: "FUNDING_FEE",
      startTime: since,
      endTime: until,
      limit: 200,
    }),
  ]);

  let realisedPnl = 0;
  let fees = 0;
  let exitNotional = 0;
  let exitQty = 0;

  for (const row of trades) {
    const pnl = Number(row.realizedPnl);
    const commission = Number(row.commission);
    const price = Number(row.price);
    const qty = Number(row.qty);
    if (Number.isFinite(commission)) {
      // Only USDT commission is comparable with USDT PnL. A fee paid in BNB is
      // a real cost but not one that can be added to this figure honestly, so
      // it is left out rather than converted at an assumed rate.
      if (row.commissionAsset === "USDT" || row.commissionAsset === "USDC") fees += commission;
    }
    if (!Number.isFinite(pnl) || pnl === 0) continue;
    realisedPnl += pnl;
    // A non-zero realised PnL marks a fill that reduced the position, which is
    // exactly the set whose average price is the exit.
    if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
      exitNotional += price * qty;
      exitQty += qty;
    }
  }

  let funding = 0;
  for (const row of income) {
    const amount = Number(row.income);
    if (Number.isFinite(amount)) funding += -amount;
  }

  return {
    realisedPnl,
    fees,
    funding,
    exitPrice: exitQty > 0 ? exitNotional / exitQty : null,
    fills: trades.length,
    empty: trades.length === 0,
  };
}

/**
 * What the daily cap should actually be measured against.
 *
 * Gross losing trades understate the day: a position closed at break-even
 * still paid commission both ways, and a position held through funding paid
 * that too. Netting the whole day — losses, fees and funding together — is the
 * figure that matches what left the account.
 */
export function dayDrawdown(a: DayActivity): number {
  const net = a.realisedPnl - a.fees - a.funding;
  return net < 0 ? -net : 0;
}
