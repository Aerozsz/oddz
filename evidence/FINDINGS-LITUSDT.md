# Findings

Generated 2026-10-23T00:28:17.833Z by the research loop. Do not edit — it is
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

38,744 samples over 29 days. Bar 3.72 sigma, round trip 7.65bp.

12 cleared the bar; **10 also beat the round trip** at an infinitesimal order — see the sizing table for what that is worth at a real one.

- `takerRatioFade` @ t1: -22.2 sigma, -7.61bp · halves -16.0/-15.8 sigma, -7.9/-7.5bp — **holds in both** · profile -1.00
- `takerRatioFade` @ t5: -21.7 sigma, -17.40bp — **beats fees** · halves -15.4/-16.0 sigma, -17.8/-17.7bp — **holds in both** · profile -0.98
- `takerRatioFade` @ t1d: -15.9 sigma, -5.59bp · halves -11.2/-11.7 sigma, -5.7/-5.7bp — **holds in both** · profile -1.00
- `takerRatioFade` @ t15: -14.3 sigma, -19.72bp — **beats fees** · halves -11.0/-10.6 sigma, -23.1/-19.8bp — **holds in both** · profile -0.95
- `takerRatioFade` @ t5d: -12.4 sigma, -9.88bp — **beats fees** · halves -8.4/-9.7 sigma, -9.8/-10.6bp — **holds in both** · profile -0.96
- `takerRatioFade` @ t30: -11.7 sigma, -22.67bp — **beats fees** · halves -9.3/-10.0 sigma, -28.0/-25.9bp — **holds in both** · profile -0.90
- `hourSin` @ t60d: -11.1 sigma, -35.41bp — **beats fees** · halves 0.2/-15.3 sigma, 1.0/-72.8bp — DOES NOT HOLD IN BOTH · profile -0.19 — **spread lives in the tails, not a gradient**
- `hourSin` @ t60: -11.1 sigma, -35.31bp — **beats fees** · halves 0.1/-15.3 sigma, 0.6/-72.7bp — DOES NOT HOLD IN BOTH · profile -0.19 — **spread lives in the tails, not a gradient**

#### Every surviving delayed horizon, priced

One tail's own mean against the depth curve, largest edge first. The detailed table below is the first row. Reading only that row is what hid a candidate with a tail three times the round trip for several weeks.

| feature @ horizon | tail edge | profile | one day | best size | $/trip |
| --- | --- | --- | --- | --- | --- |
| `volatility` @ t60d | 23.01bp | 0.18 **tails only** | 38% **episode** | $25,000 | $21.58 |
| `thinBidUp` @ t60d | 21.13bp | 0.01 **tails only** | 59% **episode** | $25,000 | $16.88 |
| `hourSin` @ t30d | 18.86bp | -0.26 **tails only** | 54% **episode** | $25,000 | $11.19 |
| `volatility` @ t30d | 15.98bp | -0.07 **tails only** | 29% | $10,000 | $5.64 |
| `topTraderFollow` @ t60d | 11.31bp | -0.24 **tails only** | 81% **episode** | $5,000 | $1.16 |
| `basis` @ t60d | 11.30bp | 0.36 **tails only** | 38% **episode** | $5,000 | $1.15 |
| `volatility` @ t15d | 10.66bp | -0.13 **tails only** | 33% | $5,000 | $0.83 |
| `thinBidUp` @ t30d | 10.37bp | -0.13 **tails only** | 60% **episode** | $5,000 | $0.69 |
| `takerRatioFade` @ t60d | 9.89bp | -0.64 | 31% | $5,000 | $0.45 |
| `hourSin` @ t15d | 9.11bp | -0.21 **tails only** | 55% **episode** | $1,000 | $0.12 |
| `takerRatioFade` @ t30d | 8.86bp | -0.66 | 21% | $1,000 | $0.09 |
| `crowdFade` @ t60d | 8.67bp | 0.24 **tails only** | 69% **episode** | $1,000 | $0.08 |
| `basis` @ t30d | 7.66bp | 0.43 **tails only** | 77% **episode** | — | — |
| `takerRatioFade` @ t15d | 6.49bp | -0.85 | 20% | — | — |
| `takerRatioFade` @ t5d | 5.02bp | -0.96 | 15% | — | — |
| `takerRatioFade` @ t1d | 2.85bp | -1.00 | 8% | — | — |

**2 of 12 paying horizons also grade with the feature and spread across the window**: `takerRatioFade` @ t60d — $0.45 a round trip at $5,000, 673 of them a day for $300 (profile -0.64, barely graded, 31% in one day, close to the episode line); `takerRatioFade` @ t30d — $0.09 a round trip at $1,000, 3,201 of them a day for $300 (profile -0.66, barely graded, 21% in one day). The shape is right, which the rest of this table is not. Whether the size is, the trades-a-day figure above decides: a signal needing one trip every few seconds is a statement about the cost floor, not an opportunity. Check it against a fresh window before believing any of it.

#### Sizing — `volatility` @ t60d, edge 23.01bp

> **This row is the largest edge, not the best supported one.** its decile profile is 0.18, so the spread sits in the extreme buckets rather than grading with the feature; and 38% of the priced tail comes from one day of 20, which is an episode rather than an effect. The table below prices it anyway, because the ordering exists so that a verdict on the largest covers the rest — not because this row is a recommendation.

Priced on **one tail's own mean return**, not the decile spread. The spread is 22.86bp — bottom decile -3.60bp, top decile -26.47bp — and capturing it means trading both tails, each paying its own round trip. A single trade earns one tail.

Priced on the tail with the window's own drift removed. The contract returned -3.46bp unconditionally over this horizon, the raw tail reads 26.47bp, and 3.46bp of that is the market moving rather than the signal working. Nothing harvests drift per trade without a view on direction.

Priced on the delayed entry. The same feature entered at the decision close reads 24.41bp, and the 1.40bp between them is the entry price sitting on the side of the book the signal fired from, not edge.

| size | cost RT | net | $/trade | trades/day for $300 | p90 net |
| --- | --- | --- | --- | --- | --- |
| $1,000 | 7.92bp | **+15.09**bp | $1.51 | 199 | 14.93bp |
| $5,000 | 9.00bp | **+14.01**bp | $7.01 | 43 | 13.21bp |
| $10,000 | 10.34bp | **+12.67**bp | $12.67 | 24 | 11.07bp |
| $25,000 | 14.38bp | **+8.63**bp | $21.58 | 14 | 4.63bp |
| $50,000 | 21.11bp | **+1.90**bp | $9.51 | 32 | -25.05bp |
| $100,000 | 50.67bp | -27.66bp | $-276.56 | never | -32.26bp |

Against impact measured on executed sweeps rather than modelled from resting depth — the full move a real order of this size made, and the part of it that reverted within a minute:

| size | net if it pays the whole move | net if it pays only the revert |
| --- | --- | --- |
| $1,000 | **+14.07**bp | **+15.36**bp |
| $5,000 | **+7.41**bp | **+13.52**bp |
| $10,000 | **+1.77**bp | **+9.09**bp |
| $25,000 | -4.10bp | **+7.31**bp |
| $50,000 | -9.29bp | **+7.00**bp |
| $100,000 | -16.83bp | **+15.36**bp |

The truth is between the two columns. A mechanical signal carries no private information, so it should not pay the whole move; it does arrive alongside informed flow, so it will not pay only the revert either.

Best size $25,000: **$21.58 a round trip**, so 14 of them a day for $300. At the ninetieth-percentile minute it is $11.57 at $25,000.

The first table prices *resting* depth. That was assumed to be optimistic — quotes are pulled as an order arrives — but 380,411 executed sweeps say otherwise above $5,000: real sweeps meet a book that refreshes, so the modelled curve runs dearer than the reverting cost, not cheaper. It is optimistic only at the smallest sizes. Read the bracket, not this table alone.

Carry at 8h, the two most crowded deciles, oriented to the side that collects:

- basis -11.6bp: **carry +11.60bp**, price -52.70bp ±6.25, total -41.10bp. The carry is the mechanical part; the price term needs a view or a hedge. Spans 27 days, largest day 14% of it — **and the price term flips sign between the halves, so it is an episode rather than an effect.**
- basis 0.3bp: **carry +0.30bp**. The price term is withheld — this bucket's rows share one basis value, so its boundaries came from array order and any return on it is a slice of the calendar, not a finding about carry.

## What a pass should do

**The search is finished.** Do not start another feature hunt; read the journal
entries from 2026-09-25 onward before deciding anything. In order:

1. Anything in `errors` or a `bad` in `diagnose` from `evidence/snapshot.json`.
2. Any run that failed, or published nothing while reporting success. That has
   happened four times and each time it looked healthy from outside.
3. A number in this file that contradicts one in `control/JOURNAL.md`. The
   journal is the argument; this file is the current reading, and they have
   disagreed before because a reader quoted a conditional figure as an
   unconditional one.
4. Nothing else. Regression, not search.

### What is settled, so no pass re-derives it

- Direction does not survive cost. Crossing loses about a basis point a trade
  to impact; resting loses more to adverse selection once a fill has to be paid
  for by volume that actually arrived at the price.
- The cost bar is measured, not assumed: the spread is one tick on the tape,
  impact is priced against the depth curve and against executed sweeps.
- Carry is real and mechanical, and the only quantity here that has survived
  every test applied to it. It is also small: 1.9bp a day at 99% one-sided on
  BTCUSDT, 0.9bp a day on LITUSDT, which ranks 203rd of 747 contracts for it.
- Hedging carry perpetual-against-perpetual works and triples the capital
  needed, because the differential is smaller than either leg.

**$300 a day needs $1.5M to $7.9M of notional depending on the route.** The
constraint is capital, not edge. The two things that would change that are a
larger account and a smaller target, and both are the operator's.

Do not arm trading. That is the operator's, and no measured route pays this
account more than a couple of dollars a day.
