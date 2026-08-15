# Sweep trading agent — handover

Written 2026-08-15 at the end of a four-day build. It is a complete account,
including of what does not work and what I got wrong, because the failures are
the expensive part of what was learned and every one of them cost real time.

Read **The verdict** first. It determines whether anything else here matters.

---

## 1. The verdict

**The strategy this agent was built around has no measured directional edge.**
Two independent measurements agree, and neither is close or ambiguous.

**Historical.** 513,000 one-minute samples across 365 days of BTCUSDT, 25
candidate features, 5 horizons. 21 findings cleared a 3.40σ Bonferroni bar.
**None cleared the 7bp round-trip cost.** The largest decile spread found
anywhere was 1.74bp.

The reason is in the excursions, and it holds in every bucket of every feature:

| bucket | mean favourable | mean adverse | asymmetry |
|---|---|---|---|
| `thinAskUp` t15 top decile | +18.2bp | −18.8bp | −0.6bp |
| `volatility` t60 top decile | +64.0bp | −66.3bp | −2.3bp |
| largest asymmetry found (`mom30` t15) | — | — | **3.8bp** |

**MFE ≈ −MAE everywhere.** Conditioned on any feature measured, the next hour is
a fair coin with a known step size.

**Live shadow.** 2,292 recorded decisions on the real book, fills modelled — the
optimistic case, with no queue, no slippage, no partial fills.

| horizon | wins | net |
|---|---|---|
| t60 | 34 / 2,288 | −$1,480 |
| t300 | 170 / 2,284 | −$1,439 |
| t900 | 407 / 2,273 | −$1,472 |

**Live testnet.** 36 closed trades, 2 wins, net −$572.72. Wallet went $5,000 →
$3,260 (reset) → $2,756.60.

### What the data does support

Direction is not predictable at these horizons. **Magnitude strongly is.**
`volatility`'s top decile has a **49.0%** chance of a ≥50bp favourable excursion
against **2.6%** in the bottom — an 18.8× lift, on 51,000 samples per bucket.

Predictable magnitude with symmetric direction is a market-making mandate, not a
directional one. As a maker you earn the spread instead of paying it, and the
7bp wall that killed every directional signal inverts. **The maker path has
never taken a single fill in 2,292 shadow trades** — it is gated behind
`canPostEntry` on mark-out toxicity and is completely unmeasured. That is the
largest unexplored lever in the project.

### The one test never run

Everything above measures one-minute bars. The sweep thesis claims a mechanism
that acts **in seconds**. Testing a seconds-scale hypothesis on minute
aggregates is precisely how such an effect disappears, and I did it for three
days before noticing.

`npm run sweep:history -- --ticks` fetches `aggTrades` (≈1 GB/month) and
`sweep:research` now pulls a short tick window every pass. **The replay for tick
data is not written.** That is the single highest-value piece of unfinished
work, and it either produces a candidate or closes the sweep thesis for good.

---

## 2. Architecture

Five long-lived processes. Only `keepalive` is started by hand; it supervises
`control`, and `control` supervises the other three.

```
keepalive ──► control ──┬──► share     (git push evidence/, pull control/)
                        ├──► research  (fetch history, replay, write rankings)
                        └──► shadow    (record decisions without ordering)
```

- **`sweep:keepalive`** — restarts control on crash; restarts it when the
  snapshot goes stale for 10 minutes (a wedged process does not exit, and every
  other supervision keys off exit); `--install` registers a Windows scheduled
  task so a reboot does not end the run.
- **`sweep:control`** — the trading loop, the dashboard, the self-check. Watches
  its own git revision and exits when non-generated paths move, which makes a
  clean exit a redeploy. Boots disarmed always, except after a restart it chose
  itself while armed.
- **`sweep:share`** — the bridge. Pushes `evidence/` every 2 minutes, pulls
  `control/` back. The trading process never runs git; a process authorised to
  place orders should not also rewrite history in a repository.
- **`sweep:research`** — fetches Binance's public archive and replays it every
  6 hours, writing `evidence/backtest-<symbol>.json`.
- **`sweep:shadow`** — runs the same strategy through an adapter that records
  instead of ordering. Real book, real decisions, modelled fill.

### Split venue, deliberately

Market data always comes from production `fapi.binance.com`; orders go to
`demo-fapi.binance.com` unless `BINANCE_LIVE=1`. A demo venue has no real
microstructure, so a strategy that reads the book cannot be tested against one.

### The bridge

`evidence/snapshot.json` is written every 30 seconds and carries: status,
limits, the refusal tally, the last 30 trade records, a shadow summary, the last
200 log lines, captured errors, operator notes, and `diagnose` — a self-check
naming what is broken and its specific fix.

Credentials, signatures and the control token are redacted **on the finished
string** rather than by field, because the failure that matters is a secret
surfacing inside a log line or a URL in a stack trace. `sweep:share` refuses to
push if the redaction did not run.

---

## 3. Configuration

`control/limits.json` is applied within 20 seconds and exactly once per
timestamp — the marker is persisted, because a file committed to the repository
was otherwise reapplied on every boot forever, overriding the operator
indefinitely.

Every setting is remotely settable **except `tradingEnabled`**. Arming, and
opening or closing positions, are the operator's alone.

`0` means **no limit** everywhere: `maxPositionUsd`, `maxOpenPositions`,
`maxTradesPerDay`, `maxDailyLossUsd`, `burstGuardSec`. This has been read as
"zero allowed" four separate times, and each one silently stopped all trading
while every diagnostic reported health. **If the agent is armed and placing
nothing, check this first.**

---

## 4. Every defect found, and what it looked like

The pattern worth internalising: **not one of these threw an error.** Each
produced a plausible number, and several produced a number that looked like a
discovery.

| Defect | Symptom | Real cause |
|---|---|---|
| `entryPrice` 0 on 25/27 records | expectancy on 2 trades beside a win rate on 27; 21 of 23 losses filed "patience problem" | market orders return `avgPrice` 0; the journal wrote it down |
| Two symbols, one directory | 271,000σ, 9,993bp spread, decile variance exactly 0 | INTC at $43 scored against BTC at $65,000 |
| `maxOpenPositions: 0` | armed, healthy, 413 signals, 0 accepted, no refusals | `0 >= 0` read as "at maximum" |
| `tradingEnabled` vs arming | every surface said armed, no loop attached | flag set without calling `armDesk` |
| Self-update restart loop | uptime 0s forever | HEAD moves every 2 min from snapshot commits |
| Research log flood | the fault's diagnosis overwritten within seconds | child relayed all output into a 200-line ring |
| Clock drift | every order rejected below the strategy, nothing tallied | −1021 was *named* in an error hint and never corrected |
| Depth-expiry churn | 5 trades closed in 1–4 min, −$70, MAE under 0.07% | `Δ ÷ thinness` — weaker signal, more sensitive trigger |
| Shadow `conditions` never assigned | four depth buckets reading `0.0000` | field declared, documented as essential, never written |
| Unsupervised shadow worker | a deployed fix changed nothing; 240 more bad rows | standalone process, never restarted, pinned to an old build |

### The reconciliation checks that would have caught most of them

Now in `diagnose` and in the Routine prompt:

1. **refusals + accepted = signals seen.** If not, the execution loop is not attached.
2. **`expectancyR.n` ≈ `learn.n`.** If not, records are missing a field.
3. **A decile with zero variance is a pipeline defect, not a discovery.**
4. **An empty bucket must never render as `0.0000`.** No data and no effect are opposite conclusions.

---

## 5. Where things are

| Path | What |
|---|---|
| `workers/sweep-control.ts` | the agent, dashboard, self-check (~6,000 lines) |
| `workers/sweep-{keepalive,share,research,shadow}.ts` | the supervised processes |
| `workers/sweep-{history,backtest}.ts` | archive fetch and feature search |
| `lib/sweep/agent/bias.ts` | the entry gate; `DEAD_ZONE` lives here |
| `lib/sweep/agent/hold.ts` | exits; the depth-expiry rule |
| `lib/sweep/agent/learn.ts` | loss anatomy, R-multiples, multiplicity |
| `lib/sweep/backtest/` | zip reader, feature definitions |
| `checks/` | 64 assertion files, one per defect class |
| `control/AUTONOMY.md` | operating procedure for unattended sessions |
| `control/JOURNAL.md` | what each pass did and why |
| `evidence/` | snapshots and backtest rankings, pushed automatically |

Never `git add -A` — a credentials file sits in the operator's working tree.
`lib/sweep/metrics/session.ts` is a Nasdaq session model and does not apply to
crypto pairs; it was left alone by instruction.

---

## 6. If you pick this up

**Do not arm it.** Both measurements say the current signal loses money, and
arming multiplies the rate of a negative-expectancy trade rather than finding a
positive one.

In order:

1. **Write the tick replay.** The data fetch exists. This is the only untested
   resolution and the one the thesis actually claims.
2. **Measure the maker path.** 0 fills in 2,292 shadow trades, worth ~$4.87 a
   round trip. Find out what `canPostEntry` is actually returning live.
3. **If both come back null, stop trying to predict direction.** The data has
   said twice, at enormous sample size, that it is not there — and has pointed
   twice at magnitude, which is a different instrument entirely.

The infrastructure is sound and worth keeping. The strategy is not proven and
should not be treated as if it were.
