/**
 * Extremes over an array of any size.
 *
 * `Math.min(...xs)` passes every element as a separate argument, so it throws
 * `RangeError: Maximum call stack size exceeded` once the array is larger than
 * the engine's argument limit — somewhere around 65,000 in practice, with no
 * warning below it and no partial failure above it.
 *
 * That is exactly the shape of bug that hides: it works on every test fixture
 * and every short run, and only fails once real data accumulates. It took down
 * the replay in the research loop — the price-span check spread every close in
 * the fetched window — so every research pass since had refused with
 * "the replay refused; nothing was written" and FINDINGS stopped regenerating,
 * while the loop itself looked like it was running.
 *
 * Returns null for an empty array rather than Infinity, because Infinity
 * silently satisfies most comparisons and turns "there was no data" into a
 * bound that quietly passes every check downstream.
 */
export function minOf(xs: readonly number[]): number | null {
  let out: number | null = null;
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    if (out === null || x < out) out = x;
  }
  return out;
}

export function maxOf(xs: readonly number[]): number | null {
  let out: number | null = null;
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    if (out === null || x > out) out = x;
  }
  return out;
}
