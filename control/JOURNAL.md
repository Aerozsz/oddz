# What each unattended pass did

Append-only. Newest at the bottom. One entry per autonomous run, however small —
a pass that changed nothing still records that it looked, because the gap
between "nothing was wrong" and "nobody checked" is the whole value of a log
like this.

Successive sessions start with no memory of each other. This file is the memory.
Read it before acting; the last three entries usually explain the state of the
run better than the snapshot does, because they carry intent and the snapshot
only carries state.

Format, one block per pass:

```
## <ISO timestamp> — <one-line summary>
saw:      <the numbers that mattered: n, win rate, net, top refusal>
did:      <what changed, or "nothing — reason">
pushed:   <commit subject, or "config only", or "-">
next:     <the lever queued for the following pass>
```

---

## 2026-08-11T10:00Z — baseline, before the loop was running
saw:      n=6 closed, 0 wins, −$63.44 net, fees $76.50 vs $13.06 gross.
          5,280 of 6,855 signals refused by an hourly ceiling floored at 2.
did:      fixed the ceiling (0 daily cap was flooring it at 2/hour); folded
          sharing into the control server; added keepalive supervision.
pushed:   "Switching the daily cap off was throttling the agent to 2 trades an hour"
next:     maker path — 0 fills in 552 shadow trades, worth ~$78/day. Then the
          −$142 vs −$63.44 accounting discrepancy.

## 2026-08-11 — the depth-expiry rule was churning the account

**State when I looked:** n=23 live, 2 wins, net −$280. 10 trades that day, $75.77
of fees against −$14.39 realised. Armed, BTCUSDT, bridge healthy both ways.

**What the aggregate said, and why it was wrong.** `learn.anatomy` reported 17 of
19 losses as `cut-on-time` with the prescription "a patience problem". Following
that would have meant raising `maxHoldMinutes`. The log said something else: five
consecutive closes at 1, 1, 2, 2 and 4 minutes held, every one of them
"depth has refilled to Nx from Mx at entry", every one with an adverse excursion
under 0.07%. Not a patience problem — the account was being churned by the exit
rule, for the second time.

**Mechanism.** `recovery = (nowLwi − entryLwi) / (1 − entryLwi)`. Dividing by the
thinness at entry makes the trigger *more* sensitive the weaker the signal: an
entry at 0.88x divides by 0.12, so a 0.15 wobble reads as 1.25 recovery. Measured
from those five round trips, the LWI moves 0.15–0.71 within 1–4 minutes, so the
noise of the series is larger than `THINNESS_FULL` (0.3), the full-signal scale
the entry gate uses. The strategy was trading its own measurement noise and
paying a round trip each time.

**Fixed.** Below thinness 0.25 the ratio is replaced by an absolute test (back to
baseline, ≥1.0x). Nothing may close on a depth reading inside
`minThesisMinutes` (3) — it lowers health and shows in the panel, but cannot
pull the trigger. Replay: 4 of 5 prevented, $41.55; the fifth was genuine.
Regression in `hold-churn-check.ts`, replaying the five by their real numbers.

**Also:** trade records now ride in the snapshot (30 rows, news dropped).
`expectancyR` said n=2 while `learn.n` said 23 and I could not see why from here,
because `data/` is not shared. That gap cost this pass an hour of inference.
`capsDerivedAt` is now persisted rather than recomputed every boot.

**Open, in order:**
1. Why does only 2 of 23 records have a computable R-multiple? Answerable from
   the next snapshot now that the rows ship. If `stopPrice` is null on the
   records, `classifyLoss` cannot reach its `never-worked` branch either, and
   the whole loss anatomy has been misfiling entry problems as patience problems.
2. The entry gate. 1717 of 1816 signals refused as "bias called no side", and the
   99 that passed entered on 0.61x–0.88x — some of those are inside the noise.
   The same noise measurement that fixed the exit applies to the entry: a
   thinness smaller than the series' own minute-scale movement is not a signal.
3. Maker path, 0 fills in 552 shadow trades, ~$4.87 a round trip.

## 2026-08-11 (later) — entryPrice was 0 on 25 of 27 records

Shipping the trade rows in the snapshot paid for itself on the first read.
`entryPrice` is 0 on 25 of 27 live records. A market order's immediate response
carries `avgPrice` 0 and the journal wrote it down; the excursion tracker had a
mark fallback, nothing else did, and the comment claiming reconciliation at close
described code that did not exist.

One empty field, three wrong outputs, all of which read as findings:
- `rMultiple` guards on `entryPrice > 0` → expectancy over 2 trades next to a
  win rate over 27, in the same object. Autotune reads it.
- `stopDistPct` has the same guard → `classifyLoss` could reach neither
  `never-worked` nor `stopped-mid-move`, fell through to the time branch, and
  filed 21 of 23 losses as `cut-on-time` = "a patience problem". Those trades had
  MFEs of 0.00–0.03% against a 0.5% stop. The summary was prescribing a longer
  hold for trades that were dying at entry.
- Anything comparing entry to exit was comparing 64,300 to 0.

Fixed: journal takes `pos.entryPrice` from Binance every sweep (authoritative,
and repairs an already-open position); mark used at submission so the field is
never 0; `classifyLoss` returns `unclassified` naming the missing field instead
of defaulting into a diagnosis. Regression in `entry-price-check.ts`.

Historical rows left alone. Entry is recoverable as `stop + (target − stop)/3`
but that lands 0.03–0.06% out against the two intact records — targets are
cluster prices, not strict multiples of the stop — which is a ~12% error in the
risk denominator. Fine for classification, not for expectancy. So the next 20
closes are the first honest sample this project has had.

**Note for the next pass:** do not trust `learn.anatomy` on rows written before
this commit. Check `trades[].entryPrice > 0` before reading any conclusion drawn
from a stop distance.

**Open, in order:**
1. Watch the first closes under the new build: `expectancyR.n` should track
   `learn.n`, and the anatomy should stop being 90% `cut-on-time`. If losses now
   read as `never-worked`, it is an entry problem and the bias is next.
2. Entry gate. 1717 of 1816 signals refused as "bias called no side"; the ones
   that passed entered at 0.54x–0.93x, several inside the series' own noise.
3. Maker path, 0 fills in 552 shadow trades, ~$4.87 a round trip.
