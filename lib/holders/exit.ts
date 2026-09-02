/**
 * Constant-product exit math.
 *
 * A holder table on its own tells you who owns what. It does not tell you what
 * that ownership is worth, which is the only question that matters when one
 * pool is the entire exit. A 44%-of-supply position against a pool holding a
 * sixth of it is not a $1.1M position — it is a $160K position with a $1.1M
 * label on it, and the difference is what this module computes.
 *
 * x*y=k with a 30bp fee, matching Uniswap V2.
 */

export const V2_FEE = 0.003;

export interface Reserves {
  /** Token reserve, human units. */
  token: number;
  /** Quote reserve, human units. */
  quote: number;
}

/** Quote received for selling `amountIn` tokens into the pool. */
export function quoteOut(amountIn: number, r: Reserves): number {
  if (amountIn <= 0 || r.token <= 0 || r.quote <= 0) return 0;
  const inWithFee = amountIn * (1 - V2_FEE);
  return (r.quote * inWithFee) / (r.token + inWithFee);
}

/** Tokens received for spending `quoteIn` of the quote asset. */
export function tokensOut(quoteIn: number, r: Reserves): number {
  if (quoteIn <= 0 || r.token <= 0 || r.quote <= 0) return 0;
  const inWithFee = quoteIn * (1 - V2_FEE);
  return (r.token * inWithFee) / (r.quote + inWithFee);
}

/**
 * Price impact of selling `amountIn` tokens, as a negative fraction.
 * -0.58 means the pool's marginal price ends 58% below where it started.
 */
export function sellImpact(amountIn: number, r: Reserves): number {
  if (amountIn <= 0 || r.token <= 0 || r.quote <= 0) return 0;
  const out = quoteOut(amountIn, r);
  const before = r.quote / r.token;
  const after = (r.quote - out) / (r.token + amountIn);
  if (!Number.isFinite(before) || before === 0) return 0;
  return after / before - 1;
}

export interface ExitResult {
  /** Notional at the current marginal price — what the wallet appears to hold. */
  paperUsd: number;
  /** What the pool would actually pay for the whole stack. */
  realizableUsd: number;
  /** Negative fraction. */
  priceImpact: number;
  /** realizableUsd / paperUsd, 0..1. */
  recovery: number;
  /** Average fill price in USD across the whole exit. */
  avgFillUsd: number;
}

/**
 * What a holder's full position is worth if they take the only exit.
 *
 * `quoteUsd` prices the quote asset. Without it the pool's output cannot be
 * expressed in dollars, so the caller gets nulls rather than a fabricated
 * number derived from the token's own price.
 */
export function exitFor(
  tokens: number,
  r: Reserves,
  quoteUsd: number | null,
  spotUsd: number | null,
): ExitResult | null {
  if (quoteUsd === null || spotUsd === null || tokens <= 0) return null;
  if (r.token <= 0 || r.quote <= 0) return null;
  const out = quoteOut(tokens, r);
  const realizableUsd = out * quoteUsd;
  const paperUsd = tokens * spotUsd;
  return {
    paperUsd,
    realizableUsd,
    priceImpact: sellImpact(tokens, r),
    recovery: paperUsd > 0 ? realizableUsd / paperUsd : 0,
    avgFillUsd: tokens > 0 ? realizableUsd / tokens : 0,
  };
}

/** Slippage ladder at fixed USD sell sizes — the pool's depth, made concrete. */
export function depthLadder(
  r: Reserves,
  spotUsd: number | null,
  sizes: number[] = [10_000, 25_000, 50_000, 100_000, 250_000],
): { sizeUsd: number; priceImpact: number }[] {
  if (spotUsd === null || spotUsd <= 0 || r.token <= 0) {
    return sizes.map((sizeUsd) => ({ sizeUsd, priceImpact: 0 }));
  }
  return sizes.map((sizeUsd) => ({
    sizeUsd,
    priceImpact: sellImpact(sizeUsd / spotUsd, r),
  }));
}

/**
 * Tokens that must hit the pool to move price down by `target` (e.g. 0.5).
 *
 * Invertible in closed form for x*y=k: a price ratio of (1-target) needs the
 * token reserve to grow by 1/sqrt(1-target), so no numerical search is needed.
 * Reported gross of the fee, which makes it a floor rather than an estimate.
 */
export function tokensToDrawdown(target: number, r: Reserves): number | null {
  if (target <= 0 || target >= 1 || r.token <= 0) return null;
  const growth = 1 / Math.sqrt(1 - target);
  return (r.token * (growth - 1)) / (1 - V2_FEE);
}
