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
