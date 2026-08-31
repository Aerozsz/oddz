# Findings

Generated 2026-08-31T19:18:04.082Z by the research loop. Do not edit — it is
rewritten every pass. Read this before the journal; the journal carries intent and
this carries what is currently true.

## Settled

Each of these cost real time to establish. Re-deriving one is a wasted pass.

- **sweep-direction** — REJECTED. A thin book on the side price must travel through predicts the direction of the next move.
  513,000 one-minute samples over 365 days, 25 features, 5 horizons. 21 findings cleared a 3.40 sigma Bonferroni bar; none cleared the 7bp round trip. Largest decile spread anywhere 1.74bp. MFE is approximately -MAE in every bucket of every feature, so the walk is symmetric conditioned on anything measured. (n=513,000)
- **cost-reduction** — REJECTED. The loss is cost, so cutting the cost fixes it — resting the entry saves about $4.87 of a $7.60 round trip.
  The first half is true and the conclusion does not follow. Across 23,820 scored decisions the round trip costs $0.5826 each and the gross price contribution is $0.0223 each: fees are 26x gross, and removing them entirely leaves $0.0223 a decision. At 300 decisions a day that is $6.68; reaching $300 a day would need 13,477 decisions daily, one every 6.4 seconds, with zero fees. Gross rises with the horizon ($0.0036 at t60, $0.0223 at t900, $0.7441 at t7200) and t7200 is the one that would pay — 403 decisions a day for $300 — but that is exactly the horizon already shown to be drift. Split by side there: longs +0.2470% at 18.7 sigma, shorts -0.2476% at -11.0 sigma, on a book that is 3:1 long. Equal-weighted the mean is -0.00033%, so the honest gross at two hours is -$0.0020 a decision. The only horizon whose gross could cover the costs is the one whose gross is the long book in a rising sample. No fee schedule fixes an edge of two cents, and the maker path is worth pursuing as market-making, not as a discount on this. (n=23,820)
- **depth-inverted** — REJECTED. The depth signal is real but backwards — thin books do worse, so the fix is free: same gate, opposite side.
  Worth testing because the pooled fifteen-minute bands ran monotonically the wrong way and thinnest-minus-thickest was 9.2bp, wider than the 7bp round trip — the first thing in this project to clear it. It does not survive. Crossed against side at every horizon: t60 long +0.78 sigma and short +0.20, t300 long -0.84 and short +0.45, t900 long -3.14 and short -0.56, t1800 long -2.36 and short -1.58, t7200 long -0.28 and short -1.08. Absent at one and five minutes, where there is no drift to explain anything away; present only at fifteen and thirty, carried mostly by longs; gone again at two hours. A microstructure effect is strongest where the mechanism acts and decays with time — this is the opposite shape, and it is what noise looks like across fifteen cells. Even taking the best cell at face value it is 5.97bp, still under the round trip. The 9.2bp came from the extreme 532-row bucket, which is the widest and noisiest slice available. (n=23,876)
- **sweep-live-shadow** — REJECTED. The same signal, measured on live decisions rather than history, does better.
  20,000+ shadow decisions on the real book with modelled fills — the optimistic case, no queue, no slippage. Negative at every horizon out to 15 minutes. Gross price contribution across 7,248 scored decisions was -$128 against $3,857 of fees: the loss is cost, not being wrong. (n=20,000)
- **hold-longer** — REJECTED. The signal works but is cut too early; holding two hours turns the loss into a profit.
  On the same 10,739 matched trades the mean runs -0.0004, -0.0005, +0.0059, +0.0423, +0.1510 percent at 1, 5, 15, 30 and 120 minutes — monotonic, 10.7 sigma. Split by side it is beta: longs +0.2750 (17.7 sigma), shorts -0.2926 (-9.5 sigma), and the book is 78% long. Equal-weighted the mean is -0.0088 percent, which is nothing. (n=10,739)
- **long-bias** — REJECTED. The entry gate is long-biased, which is a defect rather than a market fact.
  16,425 longs against 7,455 shorts across the whole file — 2.20:1. The 3.6:1 figure repeated until now was the matched two-hour subset (8,396 against 2,343), which is an older and smaller sample; both are real and they are not the same number, and the larger one should not be the one that gets quoted. A microstructure signal meant to be symmetric should not take two longs for every short, and this skew is what made the two-hour result look spectacular before the side split. It was undiagnosable by construction until now: the bias read returns a signed composite and its factors, the strategy collapsed it to buy or sell, and the shadow row set biasConviction to a hardcoded null — so the only input that picks the side was the only input never recorded. Intents now carry the decomposition and the summary averages each factor over every decision that recorded it, sorted by distance from zero. A factor comparing two sides of a book should average near zero over thousands of decisions; whichever does not is either reading a real persistent asymmetry or is signed wrong. ANSWERED 2026-08-28: it was the dead tape. With the tape restored the gate is balanced — 92 longs against 101 shorts on the rows written since, which is -0.65 sigma from an even book and -6.25 sigma from the old ratio. The skew did not drift, it ended. Two of six factors were absent, including 'who has been right', the only input scored against realised outcomes; take a quarter of the evidence from a directional read and the survivors lean. Rejected as a claim about the signal: it was never a market fact and never a property of the entry. It is also the explanation for the other three false positives here — hold-longer, depth-inverted and the two-hour gross were all killed by the same side split, all of them really the long book in a rising sample, and the long book was this. Separately kills the suspicion of a disabled dead zone: minAbsComposite came back 0.1202 against a threshold of 0.12, so the gate applies exactly as written. (n=10,739)

## Open

- **dead-tape** — TESTING. The aggTrade stream reaches no consumer, so 45% of the directional read has never fired and the maker path was never gated.
  Confirmed by two independent counters on the live production feed after 241 seconds of healthy uptime on BTCUSDT: the mark-out tracker reports tradesSeen 0, and state.flow reads {buy: 0, sell: 0}. Both are written inside the same case "aggTrade" block, so the block does not execute. Depth is fine — the book syncs and the feed check reads ok — which is why this survived weeks of a health panel that was green. What it silently disables: mark-out entirely, and with it canPostEntry, which refuses on its first line when mark-out is cold and therefore never once consulted the toxicity threshold; the bias factor 'who has been right' (weight 0.25), which the module calls the only input scored against realised outcomes rather than against the state of the book; the bias factor 'aggressive flow' (weight 0.20); the participant model; the shock tape; and the large-trade tape. The composite renormalises over present factors, so it is not shrunk toward zero — but every side this project has ever called was decided without 0.45 of the intended weight, and the 2.20:1 long skew has to be re-examined against that. Does not overturn the 513,000-sample historical result, which computed its own flow features from the archive; it does mean the 23,880 live shadow decisions were taken by a crippled version of the read. FIXED 2026-08-28 by polling the tape over REST, the way klines already came — which is exactly why volatility survived a dead kline stream and the tape did not. Mark-out is warm for the first time in this project (309 horizons resolved). Not a fix to the socket: five separate connections to fstream with the subscription acknowledged on all of them and one delivering is not something this process can repair, and the per-stream rescue sockets all reported open and silent. The tape is sampled rather than complete — a four-second poll cannot resolve the one-second mark-out horizon precisely, though the five-second one the toxicity read uses is fine — and connection.tapeVia reports which path is live so nobody reads a sampled bucket as if it came off the wire. Every conclusion drawn from the 24,061 existing shadow rows describes the crippled version and should be re-derived, not reused.
- **magnitude** — OPEN. Direction is unpredictable but magnitude is not, which is a market-making mandate.
  volatility's top decile has a 49.0% chance of a favourable excursion over 50bp against 2.6% in the bottom — an 18.8x lift on 51,000 samples per bucket. Symmetric direction with predictable step size is the shape of a spread-earning strategy rather than a directional one. (n=513,000)
- **maker-path** — OPEN. Resting the entry earns the spread instead of paying it, worth about 4.87 dollars a round trip.
  Zero fills in 23,876 shadow decisions, gated behind canPostEntry on mark-out toxicity. Was carried as 'the largest unexplored lever', which assumed the gate opens and the fills do not happen; that was never checked. Three situations produce the same zero and point opposite ways — a mark-out that never warms (defect), one that warms above the threshold (a market answer, and the lever does not exist), or an open gate with every entry still priced taker (plumbing). The summary now separates them from rows already written. Note that cost-reduction is settled against this being a rescue for the current signal: a two cent gross edge survives no fee schedule. It is worth pursuing only as the entry side of market-making, where the spread is the revenue rather than a discount.
- **sub-minute** — OPEN. The mechanism acts in seconds, so one-minute bars average it away.
  Never tested. The archive fetch takes --ticks and the research loop pulls a window each pass; no replay reads it. Everything measured so far has been on bars, testing a seconds-scale claim at minute resolution.
- **carry** — TESTING. Funding pays the unpopular side, and that payment needs no view on direction.
  Scored on every research pass as of this build, bucketed by basis decile and oriented to the collector. Reports the price move, the carry and the sum separately, because the payment is small and certain while the move against it is large and uncertain.

## Latest run

### LITUSDT

43,140 samples over 30 days. Bar 3.72 sigma, round trip 7bp.

12 cleared the bar; **11 also beat the round trip**.

- `takerRatioFade` @ t1: -21.8 sigma, -7.55bp — **beats fees**
- `takerRatioFade` @ t5: -21.8 sigma, -17.95bp — **beats fees**
- `takerRatioFade` @ t1d: -15.9 sigma, -5.65bp
- `takerRatioFade` @ t15: -12.8 sigma, -14.52bp — **beats fees**
- `takerRatioFade` @ t5d: -12.0 sigma, -9.63bp — **beats fees**
- `thinAskUp` @ t60d: -8.7 sigma, -24.23bp — **beats fees**
- `thinAskUp` @ t60: -8.3 sigma, -23.24bp — **beats fees**
- `takerRatioFade` @ t30: -8.0 sigma, -12.97bp — **beats fees**

Carry at 8h, the two most crowded deciles, oriented to the side that collects:

- basis -9.6bp: price 47.57bp ±5.53, carry +9.64bp, **total 57.21bp**
- basis 0.5bp: price -69.06bp ±6.03, carry +0.50bp, **total -68.56bp**

## What a pass should do

In order, stopping at the first that is not already done:

1. Anything in `errors` or a `bad` in `diagnose` from `evidence/snapshot.json`.
2. Write the tick replay. The fetch exists; nothing reads it.
3. Measure why `canPostEntry` has never allowed a maker fill.
4. Find why the entry gate is 3.6:1 long-biased.

Do not arm trading. That is the operator's, and every measurement says the
current signal loses money.
