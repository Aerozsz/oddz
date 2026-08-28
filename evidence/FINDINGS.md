# Findings

Generated 2026-08-28T03:41:21.116Z by the research loop. Do not edit — it is
rewritten every pass. Read this before the journal; the journal carries intent and
this carries what is currently true.

## Settled

Each of these cost real time to establish. Re-deriving one is a wasted pass.

- **sweep-direction** — REJECTED. A thin book on the side price must travel through predicts the direction of the next move.
  513,000 one-minute samples over 365 days, 25 features, 5 horizons. 21 findings cleared a 3.40 sigma Bonferroni bar; none cleared the 7bp round trip. Largest decile spread anywhere 1.74bp. MFE is approximately -MAE in every bucket of every feature, so the walk is symmetric conditioned on anything measured. (n=513,000)
- **sweep-live-shadow** — REJECTED. The same signal, measured on live decisions rather than history, does better.
  20,000+ shadow decisions on the real book with modelled fills — the optimistic case, no queue, no slippage. Negative at every horizon out to 15 minutes. Gross price contribution across 7,248 scored decisions was -$128 against $3,857 of fees: the loss is cost, not being wrong. (n=20,000)
- **hold-longer** — REJECTED. The signal works but is cut too early; holding two hours turns the loss into a profit.
  On the same 10,739 matched trades the mean runs -0.0004, -0.0005, +0.0059, +0.0423, +0.1510 percent at 1, 5, 15, 30 and 120 minutes — monotonic, 10.7 sigma. Split by side it is beta: longs +0.2750 (17.7 sigma), shorts -0.2926 (-9.5 sigma), and the book is 78% long. Equal-weighted the mean is -0.0088 percent, which is nothing. (n=10,739)

## Open

- **magnitude** — OPEN. Direction is unpredictable but magnitude is not, which is a market-making mandate.
  volatility's top decile has a 49.0% chance of a favourable excursion over 50bp against 2.6% in the bottom — an 18.8x lift on 51,000 samples per bucket. Symmetric direction with predictable step size is the shape of a spread-earning strategy rather than a directional one. (n=513,000)
- **maker-path** — OPEN. Resting the entry earns the spread instead of paying it, worth about 4.87 dollars a round trip.
  Zero fills in more than 20,000 shadow trades. Gated behind canPostEntry on mark-out toxicity and never once measured live. The largest unexplored lever in the project.
- **sub-minute** — OPEN. The mechanism acts in seconds, so one-minute bars average it away.
  Never tested. The archive fetch takes --ticks and the research loop pulls a window each pass; no replay reads it. Everything measured so far has been on bars, testing a seconds-scale claim at minute resolution.
- **carry** — TESTING. Funding pays the unpopular side, and that payment needs no view on direction.
  Scored on every research pass as of this build, bucketed by basis decile and oriented to the collector. Reports the price move, the carry and the sum separately, because the payment is small and certain while the move against it is large and uncertain.
- **long-bias** — OPEN. The entry gate is 3.6:1 long-biased, which is a defect rather than a market fact.
  8,396 longs against 2,343 shorts in the matched shadow set. A microstructure signal meant to be symmetric should not take four longs for every short, and this is what made the two-hour result look spectacular before the side split. (n=10,739)

## Latest run

### BTCUSDT

1,940 samples over 1 days. Bar 3.54 sigma, round trip 7bp.

12 cleared the bar; **0 also beat the round trip** — so none is tradeable as a directional signal.

- `mom5` @ t1: 306.1 sigma, 0.00bp
- `mom30` @ t1: 306.1 sigma, 0.00bp
- `thinBidUp` @ t1: -306.1 sigma, -0.00bp
- `bidWithdrawn` @ t1: -306.1 sigma, -0.00bp
- `ofi` @ t1: -306.1 sigma, -0.00bp
- `ofiVsVol` @ t1: -306.1 sigma, -0.00bp
- `revert5` @ t1: -306.1 sigma, -0.00bp
- `volSurge` @ t1: -306.1 sigma, -0.00bp

Carry: no premium index data — the carry question cannot be asked, this is missing data and not a null result

## What a pass should do

In order, stopping at the first that is not already done:

1. Anything in `errors` or a `bad` in `diagnose` from `evidence/snapshot.json`.
2. Write the tick replay. The fetch exists; nothing reads it.
3. Measure why `canPostEntry` has never allowed a maker fill.
4. Find why the entry gate is 3.6:1 long-biased.

Do not arm trading. That is the operator's, and every measurement says the
current signal loses money.
