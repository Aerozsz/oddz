import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { signedRequest, type BinanceConfig } from "./binance";
import { startOfDayUtc } from "./activity";

/**
 * Where today's counting starts, when the account's history stops being true.
 *
 * The day totals are read from Binance's income ledger since UTC midnight, which
 * is the right authority for every normal case: it survives restarts, and a bad
 * session cannot be laundered into a fresh one by stopping and starting.
 *
 * It has one failure mode, and a testnet account hits it regularly. A reset puts
 * the wallet back to its starting balance and does *not* remove the income rows
 * that came before it — so the ledger goes on reporting trades whose money no
 * longer exists. The agent then reads a large realised loss for "today", against
 * a balance that has never seen it. Every cap measured against the day is wrong
 * in the same direction, and the sizer is deciding from a fiction.
 *
 * So the epoch is a floor under the ledger read: counting starts at the later of
 * UTC midnight and the last time the account's balance moved for a reason the
 * ledger cannot explain.
 *
 * Detection is by arithmetic rather than by a flag, because Binance publishes no
 * flag. Every legitimate change in wallet balance has a row behind it — realised
 * PnL, commission, funding, a transfer in or out. Sum the rows since the last
 * observation, add them to the balance then, and the result should be the
 * balance now. When it is not, something moved the money outside the ledger, and
 * on a testnet account that is a reset.
 */

export interface LedgerEpoch {
  /** Income before this is not counted toward today. */
  epoch: number;
  /** Wallet balance at the last observation, for the next comparison. */
  balance: number;
  /** When that observation was taken. */
  at: number;
  /** Why the epoch last moved, for the log and the page. */
  reason: string;
}

export interface ReconcileResult {
  epoch: LedgerEpoch;
  /** Set when this call moved the epoch. */
  reset: null | { expected: number; actual: number; gap: number };
}

/**
 * How far the arithmetic may be out before it counts as unexplained.
 *
 * Not zero, because the balance and the ledger are read at slightly different
 * moments and a fill landing between them is an ordinary few-dollar difference
 * rather than evidence of anything. Both a relative and an absolute floor: a
 * percentage alone is too tight on a small account and too loose on a large one.
 */
const TOLERANCE_PCT = 0.02;
const TOLERANCE_USD = 25;

export function ledgerPath(): string {
  return resolve(process.env.SWEEP_LEDGER ?? "data/sweep-ledger.json");
}

export function readEpoch(path = ledgerPath()): LedgerEpoch {
  const fresh: LedgerEpoch = { epoch: 0, balance: 0, at: 0, reason: "never observed" };
  if (!existsSync(path)) return fresh;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerEpoch>;
    return {
      epoch: Number(p.epoch) || 0,
      balance: Number(p.balance) || 0,
      at: Number(p.at) || 0,
      reason: typeof p.reason === "string" ? p.reason : "unknown",
    };
  } catch {
    return fresh;
  }
}

export function writeEpoch(e: LedgerEpoch, path = ledgerPath()): LedgerEpoch {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(e, null, 2)}\n`);
  renameSync(tmp, path);
  return e;
}

/** The floor for a day read: never earlier than midnight, never before a reset. */
export function countFrom(now = Date.now(), path = ledgerPath()): number {
  return Math.max(startOfDayUtc(now), readEpoch(path).epoch);
}

interface RawIncome {
  incomeType: string;
  income: string;
  time: number;
}

/**
 * Compare the balance against what the ledger says it should be, and rebase if
 * they disagree.
 *
 * Deliberately account-wide rather than per-symbol. The day totals are read with
 * a symbol filter, which is correct for attributing a trade — but a transfer has
 * no symbol at all, so a filtered read cannot see the one row type that most
 * often explains a balance change, and every deposit would look like a reset.
 */
export async function reconcileLedger(
  cfg: BinanceConfig,
  walletBalance: number,
  now = Date.now(),
  path = ledgerPath(),
): Promise<ReconcileResult> {
  const prev = readEpoch(path);

  // First sight of this account: adopt the balance and start counting from
  // midnight. Nothing to compare against yet, and guessing would be worse.
  if (prev.at === 0) {
    return {
      epoch: writeEpoch(
        { epoch: startOfDayUtc(now), balance: walletBalance, at: now, reason: "first observation" },
        path,
      ),
      reset: null,
    };
  }

  let rows: RawIncome[] = [];
  try {
    rows = await signedRequest<RawIncome[]>(cfg, "GET", "/fapi/v1/income", {
      startTime: prev.at,
      limit: 1000,
    });
  } catch {
    // An unreachable ledger is not evidence of a reset. Leave the epoch where it
    // is and try again on the next sweep — the failure this guards against is
    // rebasing the day's accounting because a request timed out.
    return { epoch: prev, reset: null };
  }
  if (!Array.isArray(rows)) return { epoch: prev, reset: null };

  const moved = rows.reduce((sum, r) => {
    const amount = Number(r.income);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  const expected = prev.balance + moved;
  const gap = walletBalance - expected;
  const tolerance = Math.max(TOLERANCE_USD, Math.abs(expected) * TOLERANCE_PCT);

  if (Math.abs(gap) <= tolerance) {
    // Explained. Roll the observation forward so the next comparison is against
    // a recent balance rather than an old one.
    return {
      epoch: writeEpoch({ ...prev, balance: walletBalance, at: now }, path),
      reset: null,
    };
  }

  /*
   * Unexplained, so start counting again from here.
   *
   * Both directions matter. A credit is the testnet reset this exists for; a
   * debit with no row behind it means the account was drained by something this
   * process cannot see, and continuing to measure the day's caps against a
   * ledger that disagrees with the balance would be worse in that case than in
   * the first.
   */
  return {
    epoch: writeEpoch(
      {
        epoch: now,
        balance: walletBalance,
        at: now,
        reason:
          `balance moved ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} with no ledger row behind it ` +
          `(expected ${expected.toFixed(2)}, saw ${walletBalance.toFixed(2)}) — counting restarted here`,
      },
      path,
    ),
    reset: { expected, actual: walletBalance, gap },
  };
}

/** Start counting from now, on the operator's say-so. */
export function rebaseNow(walletBalance: number, now = Date.now(), path = ledgerPath()): LedgerEpoch {
  return writeEpoch(
    { epoch: now, balance: walletBalance, at: now, reason: "reset by hand from the dashboard" },
    path,
  );
}
