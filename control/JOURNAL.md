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

## 2026-08-12 — the walk is symmetric; direction is not there at this resolution

513,000 samples, 365 days, 14 features × 5 horizons, Bonferroni bar 3.40σ.

**Twenty-one findings clear the bar. Not one clears the fee.** Largest directional
decile spread anywhere: 1.74bp (`sweepSignal` t60) against a 7bp round trip.

The reason is in the excursions, and it is the same in every bucket of every
feature: **MFE ≈ −MAE**. `thinAskUp` t15 top decile: +18.2 / −18.8. `volatility`
t60 top decile: +64.0 / −66.3. The largest asymmetry found anywhere is `mom30`
at t15, +1.77 top against −2.02 bottom — under 4bp of edge against 7bp of cost.

So: every feature predicts **how far** price moves. None predicts **which way**.
Conditioned on any of them, the next hour is a fair coin with a known step size.

Robust and real, but sub-fee:
- `revert5` +6.7σ / `mom5` −6.7σ at t5 — five-minute mean reversion (these are
  the same feature mirrored; the feature set has redundancy worth pruning)
- `ofiVsVol` −4 to −6σ at *every* horizon — aggressive taker flow anti-predicts.
  Heavy buying precedes falls. Consistent t1 through t60.
- `thinAskUp` +3.5 to +4.2σ — the original premise, directionally real at last

Magnitude prediction is enormous and unexploited: `volatility` t60 top decile has
**49.0%** chance of a ≥50bp favourable excursion against 2.6% in the bottom — an
18.8× lift. `thinAskUp` t5 gives 4.63×.

**Why a breakout does not rescue this.** A magnitude signal is only tradeable if
the move continues after the breach. `mom5` is significantly *negative* — moves
revert — so a stop-entry breakout gets faded. Magnitude plus mean reversion means
fade-the-extension, not follow-it.

**What I got wrong.** I tested a mechanism whose own description is "works in
seconds" at one-minute resolution, on aggregated bars. If the sweep edge exists
it is likely inside the minute, and averaging over it is exactly how it would
disappear. That is the next thing to fix, not another feature.

**Next, in order:**
1. `aggTrades` — tick resolution. The archive publishes it; the fetcher already
   has the code path. Test the mechanism at the timescale it claims.
2. Percentile tails, not deciles. A top decile is 51,000 samples averaged over a
   very wide range; if the edge is concentrated in the top 0.1% no decile can see it.
3. Interactions. Single features cap at 3.8bp; conjunctions may not.
4. Maker/maker execution takes the round trip from ~7bp to ~4bp. Not sufficient
   alone — it halves the hurdle rather than clearing it — but it is a multiplier
   on whatever the three above find.

## 2026-08-12 — I broke it, then found four faults behind one symptom

Self-update shipped and immediately caused a restart loop, then hid three more
faults behind it. All four were mine. Recorded because each is a pattern, not an
incident.

1. **Restart loop.** The updater compared HEAD to the boot revision, and the
   share worker commits a snapshot every two minutes — so every heartbeat read
   as a deployment. Fixed by diffing paths and ignoring `evidence/`, `data/`,
   `control/`, plus a circuit breaker: two self-updates inside ten minutes
   disables self-update and keeps trading.
2. **`maxOpenPositions: 0` blocked everything.** `0 >= 0` read as "at maximum".
   Fourth instance of zero-means-off in this codebase; the equivalent guard 1,100
   lines earlier already handled it.
3. **The research worker destroyed observability.** It relayed every line of its
   own and npm's output into the 200-line ring, so the log that says why arming
   failed was overwritten within seconds of each pass. The process added to
   improve visibility is what hid the fault, and three diagnostic passes went to
   a cause that was being erased every thirty seconds.
4. **The real fault: `tradingEnabled` is a flag, arming is an action.**
   `resumeAfterUpdate` set the flag and never called `armDesk`. Every surface
   said armed — button, panel, self-check — with no execution loop attached to
   anything. 444 signals seen, 0 accepted, no refusal recorded, because nothing
   was there to refuse them. Fixed with a reconciler on a 20s timer rather than
   a fifth call site, because the next path added would forget too.

Verified live rather than assumed: `attached: true`, 119 seen, 41 accepted.

**The lesson worth keeping.** Every one of these was invisible in the aggregate
and obvious in the raw state. "Armed, healthy, warm, 0 accepted, no refusals" is
not a market condition — a refusal tally that does not sum to the signal count
means the loop is not running. That reconciliation belongs in `diagnose` as a
check, not as something a person notices.

## 2026-08-25T23:54:42Z — bootstrap probe

A fresh unattended session reached the repository. add_repo returned
`{"status":"appended","repo":"aerozsz/oddz","clone_url":"https://github.com/aerozsz/oddz","workspace":"/home/user/oddz"}`.
Clone took 1 second (shallow, default branch only; the target branch needed a
separate `git fetch --depth 1 origin claude/amm-liquidity-sweep-8qhnd0`).
Tools available to this session: Agent, Artifact, AskUserQuestion, Bash, Edit,
Glob, Grep, ListAgents, Read, ReadNotifications, ReportFindings,
ScheduleWakeup, SendUserFile, ShowOnboardingRolePicker, Skill, SuggestSkills,
ToolSearch, Workflow, Write; deferred via ToolSearch: WebFetch, WebSearch,
Monitor, TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate,
CronCreate/CronDelete/CronList, SendMessage, PushNotification, EnterPlanMode,
ExitPlanMode, EnterWorktree, ExitWorktree, NotebookEdit, ListSkills,
SearchSkills, ListPlugins, SearchPlugins, SuggestPluginInstall,
ListConnectors, SuggestConnectors, SearchMcpRegistry, DesignSync; MCP
(Claude Code Remote): add_repo, register_repo_root, create_session,
get_session, list_sessions, list_environments, list_repos, send_later,
create_trigger/update_trigger/delete_trigger/list_triggers/fire_trigger,
interrupt_session, archive_session, unarchive_session, set_session_title,
set_session_tags, subscribe_pr_activity, unsubscribe_pr_activity; MCP
(Vercel): deploy_to_vercel, create_git_project, list_deployments,
get_deployment_build_logs, get_runtime_logs, get_runtime_errors, and related
project/domain/toolbar tools.

## 2026-08-28T03:35Z — why fourteen days of scheduled passes produced nothing

Two walls, both now named. Neither was visible from inside a pass, which is why
150 firings never reported them.

**Wall 1: a trigger-fired session has no MCP tools.** The routine's step 1 is
"call `add_repo`". `add_repo` is an MCP tool. Creating a trigger returns this
warning verbatim:

> this trigger stores no MCP connectors, so the sessions it fires will run
> without connector (mcp__<server>__*) tools

So step 1 of the prompt cannot be executed, and steps 2–4 depend on it. The
prompt's only escape hatch — "journal what stopped you and push" — also needs
the repository, so a blocked pass could not even report being blocked. That is a
closed loop, and it explains the shape of the evidence exactly: the last run
burned 19 minutes, $3.51 and 74,000 output tokens, exited SUCCEEDED, and left no
commit. Roughly $500 of compute over two weeks, all of it spent failing at a
step that was never possible.

The lesson is not "fix the prompt". It is that **a channel that requires the
thing being tested cannot report on it.** Every blocked-pass instruction in this
project routes through git; if git is what is broken, nothing gets said.

**Wall 2: this cloud container cannot reach Binance at all.** Not the archive,
not the API:

```
$ curl https://data.binance.vision/... ; curl https://fapi.binance.com/fapi/v1/time
CONNECT tunnel failed, response 403
request blocked: no rule or allowlist entry allows host "data.binance.vision"
```

`sweep:history` returns `10 failed · 10x HTTP 403`. The environment's network
policy allowlist does not include either host. So **no cloud pass can ever fetch
market data or replay history** — every research instruction written into the
routine prompt for the last two weeks was addressed to a session physically
unable to carry it out. Item 1, the tick replay, is not slow or hard here; it is
impossible here. It can only run on the operator's machine.

**What follows.** Stop writing prompts that ask a cloud pass to fetch. The
division is forced and it is fine: the machine has the network and no judgement,
the cloud pass has judgement and no network, and `evidence/snapshot.json` is
already a working pipe between them — it lands every two minutes and currently
carries 23,854 scored shadow decisions with entry conditions on 17,881 of them.
That is a large research dataset arriving over git, needing no allowlist. The
right cloud pass reads it, writes the next measurement as code, and pushes; the
machine's self-update picks it up and the answer comes back in the next
snapshot. That loop needs no operator and no network on this side.

## 2026-08-28T03:35Z — the depth signal may be running backwards

Read off the live snapshot (23,854 shadow rows, 17,881 with entry conditions).

**The thesis, at fifteen minutes, by book depth at entry:**

| band | n | mean | sigma |
|---|---|---|---|
| very thin <0.70 | 532 | −0.0799% | −1.70 |
| thin 0.70–0.85 | 1,786 | −0.0218% | −1.65 |
| marginal 0.85–1.00 | 7,879 | +0.0048% | +1.13 |
| at/above baseline ≥1.00 | 7,650 | +0.0116% | +2.48 |

Monotone across all four bands, and pointing the **opposite** way to the
strategy's core claim. The strategy enters because the book is thin on the side
price must travel through; thin books are the bands that lose. Thinnest minus
thickest is −0.0915%, or 9.2bp — larger than the 7bp round trip, which nothing
in this project has previously cleared.

**It is not a finding yet, and I am not going to let it be read as one.** The
extreme-versus-extreme difference is 0.0915 against a difference-standard-error
of 0.0472: **1.94 sigma**, on a thin bucket of 532. That does not clear any
honest bar. Worse, it is exposed to the confound that has already killed two
results in this project — the book is 3:1 long, and if thin entries skew short
then "thin does worse" is only "shorts did worse", which is the calendar again.

So I built the test rather than the conclusion. `depthContrast` now crosses
depth against side at every horizon, with the standard error of the *difference*
computed in code so nobody eyeballs a 9bp gap and calls it decisive. The short
horizons are the sharp end of it: at t60 the overall mean is −0.0002%, so there
is no drift there to mistake for a signal, and an effect that shows up at sixty
seconds inside both sides has nowhere to hide. It ships disarmed and answers
itself in the next snapshot after the machine self-updates.

If it survives inside both sides, the strategy has been taking the wrong side of
its own signal, and the fix is free — same gate, same infrastructure, opposite
direction. If it does not, that is the third time this artefact has been caught,
and the depth thesis is finished rather than merely unproven.

**Also from the same snapshot, unchanged conclusions on more data:**

- `hold-longer` stays REJECTED, now on 13,718 matched trades rather than 10,739.
  At two hours: longs +0.2493% (18.9 sigma), shorts −0.2485% (−11.1 sigma). The
  two sides sum to +0.0004%. That is drift measured to three decimal places.
- Fees $13,865 against $563 of gross price contribution — a 25:1 cost load. The
  loss has never been about being wrong.
- 23,027 of 23,854 decisions reached neither stop nor target: 407 targets, 413
  stops. The brackets are close to a coin flip and almost never reached.

## 2026-08-28T03:50Z — the loop closed in twenty minutes, and the answer was no

Wrote the depth-by-side cross at 03:36, pushed it, and the machine's self-update
had it running by 03:43. The next snapshot carried the answer. That is the first
time in this project a question has been asked and answered inside one pass
without the operator touching anything — the cloud has judgement and no network,
the machine has network and no judgement, and `evidence/snapshot.json` turns out
to be a perfectly good wire between them. Seven minutes end to end.

**The answer: thin books do not do worse. `depth-inverted` is REJECTED.**

thin (<0.85) minus thick (>=1.00), by side, in percent:

| horizon | long | short |
|---|---|---|
| t60 | +0.0028 (+0.78σ) | +0.0010 (+0.20σ) |
| t300 | −0.0075 (−0.84σ) | +0.0063 (+0.45σ) |
| t900 | −0.0597 (−3.14σ) | −0.0149 (−0.56σ) |
| t1800 | −0.0670 (−2.36σ) | −0.0684 (−1.58σ) |
| t7200 | −0.0125 (−0.28σ) | −0.0828 (−1.08σ) |

Absent at one and five minutes — which is where it should be *strongest*, and
where there is no drift available to explain anything away. Present at fifteen
and thirty, carried mostly by longs. Gone again at two hours. A microstructure
effect is strongest where the mechanism acts and decays with time; this is the
opposite shape. Across fifteen cells, one reading −3.14σ is what noise looks
like, and the strongest cell is 5.97bp — still under the 7bp round trip. The
9.2bp that made this worth testing came from the extreme 532-row bucket, the
widest and noisiest slice on offer.

**I want to be exact about what I nearly did here.** Four bands running
monotonically the wrong way, a spread wider than the round trip, the first thing
in this project ever to clear that line — and a free fix, since inverting a gate
costs nothing. Every part of that was true and the conclusion was still wrong.
The thing that caught it was refusing to report the pooled number without
crossing it against the confound that had already killed two earlier results.
The 3:1 long book is now the single most dangerous object in this project: it
has manufactured three separate false positives, and any result that does not
survive a side split is not a result.

So the depth thesis is now closed in both directions. Thin does not predict a
favourable move (settled, 513,000 samples) and it does not predict an
unfavourable one either — there is no free trade in flipping the sign. What is
left open is unchanged and does not depend on depth: magnitude (a market-making
mandate, 18.8x lift on large excursions), the maker path (zero fills in 23,876
decisions, ~$4.87 a round trip, still entirely unmeasured), and carry.

**Next, and it is now instrumented rather than argued about.** The bias read
returns a signed composite and its factors; the strategy collapsed it to "buy"
and the shadow row hardcoded `biasConviction: null`. The only input that decides
the side was the only input never recorded, which is why the skew has been an
open item for weeks with nothing to interrogate. Intents now carry the
decomposition, both producers fill it, and the summary averages each factor over
every decision that recorded it, sorted by distance from zero. Every factor
compares two sides of a book and should average near zero over thousands of
decisions. The one that does not is either reading a real persistent asymmetry —
which would be the first genuine finding here — or is signed backwards, which is
a defect worth catching. Unlike the depth cross this needs new rows, so it fills
over the next few hours rather than in the next snapshot.

## 2026-08-28T03:53Z — the fee argument, closed with arithmetic

"The loss is cost, not being wrong" has been in this journal since the shadow
run started, and every fee-reduction idea since has leaned on it. The first half
is true. The conclusion does not follow, and the numbers were sitting in the
snapshot the whole time.

Across 23,820 scored decisions the round trip costs **$0.5826** each and the
gross price contribution is **$0.0223** each. Fees are 26x gross. Set fees to
exactly zero and the strategy earns two and a bit cents a decision.

| horizon | gross/decision | at 300/day | decisions needed for $300/day |
|---|---|---|---|
| t60 | $0.0036 | $1.07 | 83,848 |
| t300 | $0.0074 | $2.22 | 40,597 |
| t900 | $0.0223 | $6.68 | 13,477 |
| t1800 | $0.1900 | $57.01 | 1,579 |
| t7200 | $0.7441 | $223.24 | 403 |

Two hours is the one horizon that could pay: 403 decisions a day and the target
is met. It is also exactly the horizon already established as drift. Split by
side there — longs +0.2470% at 18.7 sigma, shorts −0.2476% at −11.0 sigma, on a
book that is 3:1 long. **Equal-weighted the mean is −0.00033%, so the honest
gross at two hours is −$0.0020 a decision.** The only horizon whose gross could
cover its costs is the one whose gross is the long book in a rising sample.

So `cost-reduction` is REJECTED as a settled verdict, and this is the fourth
result the 3:1 long book has manufactured. The maker path stays open but its
justification changes completely: it is not a discount that rescues this signal —
no fee schedule rescues an edge of two cents — it is the entry side of market
making, where the spread is the revenue rather than a saving. That is the same
place the magnitude finding points, and those two are now the only live threads.

I also stopped assuming the maker gate's zero meant one thing. Three situations
produce an identical count of zero fills and point in opposite directions: a
mark-out that never warms (the gate refuses on its first line, a defect), one
that warms above the threshold (a market answer, and the lever does not exist),
or a gate that opens with every entry still priced as a taker (plumbing). The
summary now separates them and names which it found, from rows already written.
Answer due in the next snapshot.

## 2026-08-28T03:58Z — the maker path was never gated on toxicity

`makerPath` landed and answered in one snapshot. Of 17,898 decisions carrying a
mark-out reading, **warm: 0**. Not one. The toxicity test has run zero times.

`canPostEntry` refuses on its first line when mark-out is cold. So the entire
maker path — carried in FINDINGS for weeks as "gated behind canPostEntry on
mark-out toxicity, worth about $4.87 a round trip, the largest unexplored lever
in the project" — was never gated on toxicity. It was never reached. The
sentence described a market condition; the reality was a warm-up that never
completes, on a live BTC feed that has been up for two days.

It is not a shadow artefact either: all 30 live trade records in the snapshot
carry `markoutWarm: false` too.

**The second casualty, which I had not connected.** The bias factor "who has
been right" is guarded by `mk.warm` and carries weight 0.25 — a quarter of the
directional read. It has therefore never once contributed to a side decision.
Every long/short call this project has ever made was taken with a quarter of the
bias weight absent, and the module's own comment calls that factor "the one
input scored against realised outcomes rather than against the state of the
book". The one factor with a track record has been dead the whole time, and it is
a plausible piece of the 2.20:1 long skew.

**Why it was invisible.** `warm` is an AND of three conditions reported as one
boolean, so a cold tracker says nothing about which gate is shut. I cannot run
the feed from here — this container cannot reach Binance — so the fix is to make
the running thing report: `warmth` now carries `resolved`, `tradesSeen`,
`sinceFirstTradeMs` and `mainWeight`, and a per-desk diagnose check names the
unmet condition in words. The next snapshot says whether the trade stream reaches
the tracker at all, or reaches it and fails to resolve.

Found on the way: `firstTradeAt` starts at zero, so `now - firstTradeAt` is
thirty years of milliseconds and the sixty-second gate passed vacuously on a
tracker that had never seen a trade. Sixth zero-means-something-else in this
codebase. It did not change the verdict — `resolved` was zero too — but the
reason reported would have been the wrong one, which is how the last two days
went.

**The pattern, for whoever reads this next.** Three times today a sentence in
FINDINGS asserted a market fact that was actually an unmeasured pipeline: depth
buckets reading 0.0000 because nothing populated them, a maker path "gated on
toxicity" that never reached the gate, and a fee argument that assumed the gross
was worth rescuing. Every one of them read as a finding and was a defect. The
check that catches this class is cheap and I should apply it before writing any
sentence of that shape: **if a claim says the market refused, confirm the code
asked.**

## 2026-08-28T04:08Z — the tape has never been connected

Two independent counters, live production feed, BTCUSDT, 241 seconds of healthy
uptime, book synced, `feed: ok`:

- mark-out tracker: `tradesSeen: 0`
- `state.flow`: `{ buy: 0, sell: 0 }`

Both are written inside the same `case "aggTrade"` block in the engine. The
block does not execute. **The aggTrade stream reaches no consumer, and has not
for as long as anyone has been looking at this.**

Depth is fine. That is exactly why this survived: the health panel is green, the
book syncs, `feed: BTCUSDT: ok`, and every depth-derived number is real. A dead
tape on a live book looks like a working system from every surface this project
had.

**What it silently disables.**

- Mark-out, entirely — and with it `canPostEntry`, which refuses on its first
  line when mark-out is cold. The maker path was never gated on toxicity. It was
  never reached. That is this morning's finding, and this is its cause.
- The bias factor **"who has been right"**, weight 0.25 — which bias.ts itself
  calls "the one factor scored against realised outcomes rather than against the
  state of the book". The only input with a track record has never fired.
- The bias factor **"aggressive flow"**, weight 0.20.
- The participant model, the shock tape, the large-trade tape.

So **0.45 of the intended directional weight has never contributed to a single
decision.** The composite renormalises over present factors, so it is not shrunk
toward zero — the surviving factors were simply promoted to carry everything:
cost to trigger, which side thinned, nearest trigger, funding, and resting
imbalance, the last of which the module's own comment calls "the cheapest
deception in the book".

**What this does and does not overturn.** It does not touch the 513,000-sample
historical result — that computed its own flow features from the archive and
never used this code path. It does mean the 23,880 live shadow decisions were
taken by a read missing nearly half its evidence, and the 2.20:1 long skew now
has an obvious place to look. The `biasFactors` recording shipped an hour ago
will name which of the *surviving* factors leans, as new rows accumulate.

I am not going to claim this is the reason the strategy loses. The historical
work is independent and says the same thing, and a dead tape does not turn a
symmetric random walk into an edge. What it does mean is that the live evidence
was never a fair test of the design as written, and every conclusion drawn from
the shadow file describes a crippled version of it.

**Why it took this long.** `warm` is an AND of three conditions reported as one
boolean; `canPostEntry` reports a cold tracker as toxicity, which reads as a
market condition; and `feed: ok` asserts health from the depth stream alone
while four consumers of a second stream sit silent. Three layers each turned a
missing input into something that looked like an answer. The check that would
have caught it in a day is the one now in `diagnose`: a stream with subscribers
and no messages is a fault, and no aggregate health reading should be able to
report green while a subscribed stream has delivered zero.

## 2026-08-28T09:00Z — the tape is connected, for the first time

Mark-out is warm. `resolved 309, weight 20702276`. It has never been warm before
in this project.

**The chain, in order.** The maker path was carried for weeks as "gated behind
canPostEntry on toxicity, worth $4.87 a round trip, the largest unexplored
lever". Decomposing that zero showed the gate was never reached — `canPostEntry`
refuses on its first line when mark-out is cold, and mark-out was cold on all
17,898 decisions carrying a reading. Instrumenting the warm-up showed
`tradesSeen: 0`. A second counter agreed: `state.flow` read `{buy: 0, sell: 0}`.
The census showed why — 124,362 depth frames and nothing at all on aggTrade,
markPrice or kline.

**What it was not.** The URL is correct and round-trips through `URL()`
unchanged. The stream names are standard. The frame parser passes every combined
payload. An explicit SUBSCRIBE was acknowledged — `{"result":null,"id":1}` — so
client-to-server frames land and the subscription is accepted for all five
names. Per-stream rescue sockets to the single-stream endpoint all reported
`open` and received nothing. Five separate connections to fstream, subscription
accepted on all of them, one delivering. Nothing in this process can fix that,
and I stopped trying to.

**What worked.** Klines already come over REST, which is precisely why volatility
survived a dead kline stream while the tape did not — so the tape now comes the
same way. `fetchAggTrades` continues from the last print by id so polls neither
duplicate nor skip; it arms only after ninety seconds of a genuinely silent
stream, since aggTrade on a liquid contract runs at hundreds a second and
silence that long is absence rather than quiet; and the WS and REST paths share
one `ingestTrade`, because a tape feeding mark-out but not the participant model
would be worse than no tape — every reading downstream would quietly describe a
different market.

First attempt polled every two seconds for a thousand prints and drew 429s. It
still warmed mark-out, which is the part worth noticing: it worked immediately.
It now honours the cooldown the client already tracks and backs off from four
seconds to a minute. The tape is sampled rather than complete, and `tapeVia`
says so in the snapshot, because a two-second poll cannot resolve a one-second
mark-out horizon precisely and nobody should read those buckets as if they came
off the wire. The five-second horizon — the one the toxicity read actually uses —
is fine.

**What this turns back on.** `canPostEntry` will consult the toxicity threshold
for the first time, so the maker path becomes measurable instead of theoretical.
The bias factor "who has been right" (weight 0.25) starts contributing — bias.ts
calls it the only input scored against realised outcomes rather than against the
state of the book, and it has never once fired. "Aggressive flow" (0.20) returns.
The participant model, the shock tape and the large-trade tape come back.

**What I am not claiming.** This does not make the strategy profitable and there
is no evidence yet that it will. The 513,000-sample historical result computed
its own flow features from the archive and never used this path; it stands, and
it says there is no directional edge. A tape does not turn a symmetric random
walk into one. What changed is narrower and still worth the day: for the first
time the live evidence is a fair test of the design as written, rather than of a
version missing 0.45 of its directional weight and its entire maker path. Every
conclusion drawn from the 24,061 shadow rows describes the crippled version.

**The rule this session earned.** Three separate sentences in FINDINGS asserted a
market fact that was an unmeasured pipeline: depth buckets reading 0.0000 because
nothing populated them, a maker path "gated on toxicity" that never reached the
gate, and a fee argument resting on a gross figure worth rescuing. Each read as a
finding and was a defect. Before writing any sentence of that shape:
**if a claim says the market refused, confirm the code asked.**

## 2026-08-28T14:30Z — the long bias was the dead tape

Five and a half hours with the tape connected. 385,573 prints polled, `tape via
rest`, mark-out warm and stable at 6,362 resolved horizons.

**The entry gate is balanced.**

| | longs | shorts | ratio |
|---|---|---|---|
| every row ever written | 16,586 | 7,610 | 2.18:1 |
| rows since the tape came up | 92 | 101 | 0.91:1 |

Against an even book the new rows sit at −0.65 sigma: indistinguishable from
even. Against the old ratio they sit at **−6.25 sigma**. The skew did not drift,
it ended.

So the 2.18:1 long bias was never a market fact and never a property of the
signal. It was two missing factors. "Who has been right" — the only input in
this project scored against realised outcomes rather than against the state of
the book, weight 0.25 — has fired 59 times today and never once before. Take a
quarter of the evidence away from a directional read and the four survivors lean;
give it back and they stop.

**This is the fourth false positive explained, and it explains the other three.**
The two-hour "edge", the inverted depth signal, the two-hour gross that looked
like it could cover its costs — every one of them was killed by the same side
split, and every one of them was really the long book in a rising sample. The
long book was the dead tape. Four separate results, one cause, and the cause was
a stream that never arrived.

**The maker path is open too.** 30 maker entries — the first in this project's
history, against 24,166 taker entries. The gate opened on 30 of 60 warm
decisions, and mean toxicity is 0.543 against a 0.6 threshold. That is the
interesting part: the flow really does sit just under the line, so the threshold
is doing real work rather than being unreachable. "Zero fills, gated on
toxicity" was true about the gate and false about the reason for weeks.

**One hypothesis killed on the way.** `minAbsComposite` came back 0.1202 against
a dead zone of 0.12, so the gate is being applied exactly as written. The
seventh zero-means-off I went looking for is not there.

**What this does not mean.** The strategy is still not profitable and nothing
here says it will be. The 513,000-sample historical result computed its own flow
features from the archive, never touched this path, and still says there is no
directional edge. A working tape does not turn a symmetric walk into one. What
changed is that the live evidence is now a fair test of the design as written —
and that every conclusion in FINDINGS drawn from the 24,196 rows written before
today describes a version of the agent missing 0.45 of its directional weight
and its entire maker path. Those need re-deriving on the new rows, not reusing.

The honest summary of the day: I did not find an edge. I found that the thing
that was supposed to be looking for one had been running with a quarter of its
evidence disconnected, and the four most promising results it produced were all
artefacts of that. It is now measuring what it was designed to measure, for the
first time.

## 2026-08-31T20:40Z — the runner works, and the first LITUSDT result splits in two

The archive replay runs on a GitHub runner now, with the operator's machine off.
It pulled 120 files and 18 MB of LITUSDT history and produced the first result
this project has seen that clears both bars at once. Twelve findings cleared a
3.72 sigma Bonferroni bar, and eleven also beat the cost bar. Nothing in 513,000
BTCUSDT samples ever beat that cost bar.

That is exactly when to try hardest to break it, so I did, and it broke in half.

**The bounce test.** Returns were measured from the decision minute's close —
its last trade. A taker-ratio feature correlates with which side that trade hit
by construction, so the entry price carries half the spread and the forward
return reverts mechanically. Untradeable: a real entry pays the same spread it
appears to earn. Invisible on BTCUSDT at a 0.012bp spread; the first thing to
rule out on a small-cap. Every horizon now also scores an entry one bar later,
where the next bar's close is not the trade the feature was computed from.

| feature | immediate | one bar later | edge kept |
|---|---|---|---|
| takerRatioFade t1 | −21.8σ, −7.55bp | −15.9σ, −5.65bp | 75% |
| takerRatioFade t5 | −21.8σ, −17.95bp | −12.0σ, −9.63bp | 54% |
| takerRatioFade t15 | −12.8σ, −14.52bp | −5.9σ, −6.81bp | 47% |
| thinAskUp t30 | −3.7σ, −7.67bp | −4.0σ, −8.46bp | 110% |
| thinAskUp t60 | −8.3σ, −23.24bp | −8.7σ, −24.23bp | 104% |
| sweepSignal t30 | −6.5σ, −14.98bp | −6.7σ, −15.34bp | 102% |
| sweepSignal t60 | −7.6σ, −23.95bp | −8.0σ, −25.25bp | 105% |
| topTraderFollow t60 | 7.6σ, 27.51bp | 7.4σ, 26.72bp | 97% |

**`takerRatioFade` — the top-ranked finding — is roughly half entry artefact.**
It loses more of its edge the longer you look, 25% then 46% then 53%, and its
sigma collapses from 21.8 to 5.9 at fifteen minutes. At one minute it falls under
even the fees-only bar. That is what a bounce contaminated signal looks like, and
it was the headline of the first report.

**Three others survive intact.** thinAskUp, sweepSignal and topTraderFollow at
thirty and sixty minutes keep 97–110% of their edge. That is the right shape:
bounce is a one-tick effect worth about 2bp, which is most of a 7.55bp one-minute
edge and almost none of a 23bp hourly one. So the test both confirms the artefact
is present and shows these three are too large to be explained by it.

**What I have not ruled out, and will not pretend I have.**

1. **The cost bar is fees-only.** Seven basis points is two taker fills and
   nothing else — no spread, no slippage, no queue. It was defensible on BTCUSDT
   where the spread rounded to zero. LITUSDT's real round trip is unmeasured, and
   at a plausible 15–25bp it could eat every one of these. Measuring it is the
   next job, and ROUND_TRIP_BPS is now overridable so the real number can be used.
2. **Thirty days, one contract, no out-of-sample split.** 125 tests with a
   Bonferroni bar is not the same as a holdout.
3. **No side split.** Four results in this project have died on that split. These
   have not been through it.

So: the most promising thing this project has produced, three features that
survive the artefact most likely to explain them, and three specific ways it
could still be nothing. Not a signal to trade. A candidate to attack.

## 2026-08-31T21:05Z — two tests, and each killed what the other missed

The holdout landed and it corrects my last entry. I said takerRatioFade was the
contaminated one and thinAskUp, sweepSignal and topTraderFollow were the clean
survivors. Refitting each half of the window says close to the opposite.

**topTraderFollow is dead, and it was the biggest number in the run.** 7.6 sigma
and 27.5bp over the full window; first half −2.2 sigma at −8.2bp, second half
+14.2 sigma at +61.3bp. **The sign flips.** The entire finding is the back half
of one month, and had the run stopped at the bounce test it would have passed —
it keeps 97% of its edge when entered a bar later, because a fortnight-shaped
artefact is not a spread artefact. Two different tests, two different failure
modes, and only running both caught it.

**thinAskUp @ t60 fails too**: −6.5 sigma in the first half, −1.6 in the second.
So does thinBidUp @ t30, which is −0.3 then −7.2 — the mirror image, carried by
the other half.

**What survives everything.** Bounce-immune (entered a bar later), both halves
individually significant, and past the cost bar:

| finding | full | half A | half B |
|---|---|---|---|
| `sweepSignal` @t60d | −8.0σ, −25.3bp | −6.0σ, −19.6bp | −5.8σ, −31.3bp |
| `asymmetry` @t60d | −7.1σ, −22.1bp | −4.3σ, −13.8bp | −5.1σ, −26.8bp |
| `sweepSignal` @t30d | −6.7σ, −15.3bp | −4.2σ, −10.3bp | −5.4σ, −21.2bp |
| `takerRatioFade` @t5d | −12.0σ, −9.6bp | −7.7σ, −6.8bp | −9.6σ, −14.1bp |

takerRatioFade does lose about half its edge to the delay, as I said — but what
is left survives the split cleanly at every horizon, which I got wrong by
implying the delay had gutted it.

**The sign is the finding.** sweepSignal, asymmetry, thinAskUp and takerRatioFade
are all **negative**. sweepSignal is this project's own core signal, and it
predicts the move in the direction opposite to the thesis. This is the
depth-inverted hypothesis again — the one I rejected on BTCUSDT shadow data — and
on LITUSDT archive data it survives a bid-ask bounce test and a time holdout at
25bp on 43,140 samples. Rejecting it there and finding it here is not a
contradiction: different contract, different liquidity, and the BTCUSDT rejection
was 15 cells of a shadow file, not a controlled replay.

**The one thing standing between this and a candidate: the cost bar is fees
only.** Seven basis points is two taker fills. LITUSDT's real round trip includes
crossing a spread on a small-cap book twice, and that number is unmeasured. At a
plausible 15–25bp it eats sweepSignal @t60d entirely. Measuring it is now the
single highest-value job in the project, ahead of everything in the pass list,
because it is the difference between a finding and an artefact of using
Bitcoin's cost structure on an altcoin.

Nothing here is a reason to arm anything.

## 2026-09-18T13:35Z — the cost bar, measured, and the one thing that survives it

I dropped this for fourteen days. The blocker was found on 09-02, reported, and
then nothing — no run between 08-31 and today except one aborted boot on 09-04.
Escalating and waiting is the failure mode this project exists to avoid. The
self-scheduling Routine built today could have been built on the 2nd.

**The cost bar is 12.25bp, not 7.** Fees 7 plus a measured spread of 5.25. That
is the number the whole LITUSDT result turned on and it had never been measured —
7bp was two taker fills, calibrated on a contract whose spread rounds to 0.012bp.

**It rests on one estimate, not two, and that is a real weakness.** The design
called for Roll's estimator and the delayed-entry test to cross-check each other.
Roll returned null: non-negative autocovariance, so momentum dominates the bounce
at one-minute resolution and the estimator has no real root. Null rather than
zero is correct — a zero spread is a bar everything clears — but it leaves the
bar resting on the delayed-entry estimate alone, uncorroborated.

**What clears all three filters** — entered a bar later so bid-ask bounce cannot
explain it, individually significant in both halves of the window, and past the
12.25bp bar:

| finding | full | halves |
|---|---|---|
| `takerRatioFade` @t5d | −16.1σ, −16.64bp | −9.7 / −13.0 |
| `takerRatioFade` @t15d | −9.5σ, −15.58bp | −5.5 / −7.8 |
| `mom30` @t60d | −4.6σ, −18.45bp | −2.7 / −4.8 |
| `oiChange` @t60d | +3.7σ, +15.26bp | +2.0 / +4.3 |
| `basisFade` @t60d | −4.3σ, −15.14bp | −2.4 / −4.2 |
| `basisStretch` @t60d | +4.3σ, +15.14bp | +2.4 / +4.2 |

**basisFade and basisStretch are the same feature twice.** −15.14 and +15.14,
mirrored sigmas. Counting both inflates the discovery count and would inflate any
multiplicity correction applied afterwards. Two entries, one fact.

**The strongest evidence available is accidental.** This run replayed a different
thirty-day window from the 08-31 run — the fetch takes the last thirty days, and
eighteen days had passed. That makes it an out-of-sample test nobody designed.
Almost nothing survived it: `sweepSignal`, `asymmetry` and `topTraderFollow` are
gone from the top, and `thinAskUp` @t60d now *flips sign across halves*, −6.7
then +1.2. On 08-31 those three were the ones I called clean survivors.

**`takerRatioFade` is the only thing that holds across both windows**, and it is
stronger here than there. It survives the bounce test, both halves of both
windows, and a measured cost bar. Nothing else in this project has ever done
that.

**What would still kill it.** The bar has one leg, not two. Cost is fees plus one
spread and models no size impact — the decile is a tenth of the sample, and the
book that has to absorb it is thin. It is one contract. And the carry line in
this run reads 152bp of price move in the collector's favour at ±6.9, which is a
22 sigma claim about funding and is far more likely to be the extreme-decile
artefact this project has already caught four times than a real effect; I am not
treating it as a finding.

Not a reason to arm anything.

## 2026-09-18T18:40Z — the scheduler works, and the cross-contract test undercuts the finding

**The Routine fired into this session and reached a session with tools.** First
scheduled pass in this project's history to do so. The old one spawned cold
sessions with no MCP tools and burned ~150 firings for nothing; binding to a live
session is the difference. Confirmed, not assumed.

**Process error worth writing down.** I read "results" before the run finished,
because my wait condition checked for `evidence/FINDINGS-BTCUSDT.md` to exist —
and it already did, left by the operator's machine on 08-31. I reported the stale
file's 1,940-sample degenerate output as though it were this run's. Waiting on a
file that already exists is not waiting. The condition is now the runner's own
commit subject.

**The cross-contract test.** takerRatioFade had survived the bounce test, both
halves of two windows, and a measured cost bar — all inside one contract. BTCUSDT
is the control: the 513,000-sample study found nothing tradeable there, and its
book is the opposite of LITUSDT's.

| | LITUSDT | BTCUSDT |
|---|---|---|
| cost bar | 12.25bp | 9.47bp |
| Roll | **null** | 2.47bp |
| delayed-entry | 5.25bp | 1.70bp |
| basis | one leg | **both agreed** |
| takerRatioFade @t1d | −16.9σ, −7.95bp | −16.3σ, −1.80bp |
| takerRatioFade @t5d | −16.1σ, −16.64bp | −13.9σ, −3.26bp |
| takerRatioFade @t15d | −9.5σ, −15.58bp | −7.8σ, −2.90bp |

**The effect is real on both, and its size tracks the spread.** Same sign, same
order of significance, holding in both halves on both contracts — so it is not a
LITUSDT accident. But LIT's spread is ~2.5x BTC's and the effect is ~5x larger.
It scales *faster* than the spread, which is what a cost artefact looks like, not
what an edge looks like. On BTCUSDT it is 3.26bp against a 9.47bp bar:
unambiguously untradeable, exactly as the 513,000-sample study said.

**So the honest position on the one surviving candidate is worse than it was
this morning.** takerRatioFade @t5d clears the LITUSDT bar by 4.4bp — and that
bar is the one resting on a single estimator, because Roll returned null there.
On BTCUSDT, where both estimators ran and agreed, the same feature is nowhere
near its bar. The contract whose bar I trust least is the only one where the
finding survives.

**The next job is therefore specific, not exploratory.** LITUSDT needs a second,
independent spread estimate. Roll fails at one-minute resolution because momentum
dominates the bounce; on tick data the bounce dominates instead, which is the
resolution Roll was designed for. `sweep:history --ticks` already fetches
aggTrades and nothing has ever read them. A few days is enough for a spread.
If LITUSDT's real round trip is 17bp or more, takerRatioFade @t5d is dead and so
is everything else in this project.

## 2026-09-19T01:05Z — the spread is one tick, so the question was never the spread

Second scheduled pass. The Routine fired into this session again and reached a
session with tools, so the scheduler is working.

**I shipped the argument-limit bug a second time.** `prints.push(...day)` in the
new tick worker — 666,782 prints spread as arguments, `RangeError: Maximum call
stack size exceeded`. It is the identical bug to `Math.min(...closes)` in the
replay, which refused every research pass for six days three weeks ago, which I
found, fixed and wrote up in this journal. The step carried `|| true`, so both
symbols failed silently and the run reported success.

A comment saying "do not do this" did not prevent it. There is now a check that
scans `workers/` and `lib/` and fails on any spread into a call not explicitly
declared bounded, with the bound written down. It found eight more: five were
genuinely bounded and are declared, two were not — the thinning buffer and the
news-store ages are sized by retention policy, not by a constant — and one was a
rest parameter, which is a declaration rather than a call.

**The measurement, once it ran.**

| | prints | flips | median flip gap | Roll on ticks |
|---|---|---|---|---|
| LITUSDT | 1,847,583 | 221,956 | **0.243bp** | 0.54bp |
| BTCUSDT | 4,506,656 | 793,966 | **0.01bp** | 0.31bp |

My first reaction was that this had to be broken, because a spread cannot be
narrower than one tick. It is not broken — it is exactly one tick, on both.
LITUSDT trades $4.00–$5.04 and a 0.0001 tick at $4.00 is 0.25bp. BTCUSDT at
about $100,000 with a 0.1 tick is 0.01bp. Two contracts, two tick sizes, each
returning precisely its own. That agreement across wildly different price scales
is the internal check that the number is real, and the worker now reports the
zero-gap share and the 75th and 90th percentiles so a one-tick book can be told
from a broken statistic without having to reason it out again.

**So the minute-level estimates were inflated, badly.** LITUSDT's delayed-entry
bar said 5.44bp against a true spread of ~0.25. BTCUSDT's Roll said 1.02 and its
delayed-entry 1.68, against ~0.01. Both were reading genuine one-minute mean
reversion as bid-ask bounce. The cost bar has been built on that since it was
first measured.

**And yet I am not lowering the bar.** A one-tick spread is what a *tiny* order
pays. The finding is a decile — a tenth of the sample — and on a book that is
one tick wide but thin, the binding cost is walking that book, not crossing it.
The spread turns out to be a rounding error and impact turns out to be the whole
question, which is the opposite of the assumption this project has carried since
the cost bar existed. The old 12.44bp bar was accidentally in a sensible range
for entirely the wrong reason, and lowering it to 7.25 on this measurement would
be the cheap-direction error the cost module's own comments warn against.

**Next is therefore impact, and the data for it is already downloaded.** The
archive's `bookDepth` gives notional resting within ±1% each side, per minute.
Against an intended order size that yields how far a decile-sized order walks —
which is the missing term, and the one that decides whether `takerRatioFade`
@t5d at −16.66bp is tradeable or is eaten.

## 2026-09-19T18:50Z — the cost is fully measured, and there is a capacity knee

I let two scheduled kicks pass without doing the work. That is the drop I was
put in charge of preventing, and it is the second time in this project that
noticing a thing and acting on it came apart.

**Two of my own bugs first, both the same shape as ones already in this
journal.** `prints.push(...day)` threw the argument-limit RangeError I had fixed
three weeks earlier in the replay — there is now a check that fails on any
spread into a call not declared bounded, and it found eight more. Then the
impact worker reported "30 file(s), 0 minutes": bookDepth writes timestamps as
text dates, `Number("2026-09-15 00:00:00")` is NaN, and `parseTs` — written for
this, sitting in the same module I was already importing from, used by the
replay since the beginning — went unused. Both steps carried `|| true`, so both
failed silently inside runs that reported success.

**The cost is now measured end to end.** Spread from the tape at direction
flips, impact from the depth curve the replay had been discarding.

LITUSDT, against `takerRatioFade` @t5d at −16.66bp:

| size | impact RT | total cost | net edge | $/trade | trades/day for $300 |
|---|---|---|---|---|---|
| $1,000 | 0.36bp | 7.84bp | **+8.82bp** | $0.88 | 341 |
| $5,000 | 1.79bp | 9.27bp | **+7.39bp** | $3.69 | 82 |
| $10,000 | 3.57bp | 11.06bp | **+5.60bp** | $5.60 | 54 |
| $25,000 | 8.93bp | 16.42bp | +0.24bp | $0.61 | 493 |
| $50,000 | 16.87bp | 24.35bp | **−7.69bp** | −$38.46 | never |

Fees are 7bp of that and the spread is half a basis point. **Impact is the whole
shape of the curve**, exactly as the one-tick spread measurement implied, and
the knee sits between $10,000 and $25,000. BTCUSDT's book absorbs $100,000 for
0.03bp round trip — which is why nothing was ever found there and why the
finding lives on the thin contract.

**So the honest statement is narrow and quantitative.** The strategy has an edge
of about 5.6bp net at $10,000 a trade, it fires roughly 144 times a day as the
top decile of a five-minute signal, and $300/day needs 54 of those to be taken
and to behave like the sample. It is capacity-limited to about $25,000 before
impact eats it, which is a ceiling on the whole approach rather than a parameter
to tune.

**What would still overturn it.** The impact model prices resting depth, and
resting is not available — quotes are pulled as an order arrives, so the real
curve is worse than this one and the knee is lower than $25,000, not higher. The
edge is one contract over one month, though it held across two separate windows
and both halves of each. And a decile is the extreme tenth: trading it means
taking only those, and the count of 144 a day assumes every one is actionable.

Nothing here is a reason to arm. It is the first time this project has had a
number worth arguing with.

## 2026-09-20 — the numbers were in the repo, unread

Three scheduled kicks today. The first ran clean and exposed two files the
research loop has been writing for weeks that nothing ever read back. Both of
them were deciding verdicts.

**The spread.** `evidence/spread-LITUSDT.json` has held the tape measurement
since the tick worker shipped: 0.243bp, landing exactly on the contract's own
tick size, observed at direction flips where `isBuyerMaker` states which side
crossed. The replay ignored it and built its bar from the larger of two
minute-resolution estimators — Roll at 0.48bp, the delayed-entry test at 5.52bp
— for a bar of **12.52bp**. Taking the larger is the right rule between two
estimates that cannot be checked. It is the wrong rule once the quantity has
been observed. Both estimators read a price path, and at one-minute resolution
that path is momentum rather than bounce, so they measure mean reversion and
call it spread. Every finding worth between 7 and 13 basis points was being
failed by a number this project had already disproved, in a file sitting beside
the one it wrote. The bar is now **7.48bp** — fees plus the measured spread on
both legs.

**The depth.** `evidence/impact-LITUSDT.json` prices an order against the
archive's depth curve. Nothing consumed that either, so the bar stayed a scalar:
the cost of an order small enough not to exist. On a contract whose spread is
one tick, walking the book *is* the cost, and the scalar bar charged zero for
it. FINDINGS now carries a size ladder, and the table is the deliverable rather
than the verdict — the size is the operator's decision and one recommended
number would hide it the same way the constant did.

**The pass then caught me sizing the wrong number.** The ladder's headline is
picked by sigma, which selected `takerRatioFade @ t5` at 26.63bp over `t5d` at
16.06bp — the same feature entered one bar later. The 10.57bp between them is
not edge; it is the entry price sitting on whichever side of the book the signal
fired from, which is the exact artefact the `d` horizons exist to expose. I had
shipped a table quoting dollars per trade on a figure the project's own test
says is 40% bounce. The ladder is built on the delayed number now, with the
immediate one printed beside it so the artefact stays visible.

**The publish step was broken and reported success.** Run 19 recomputed every
report and pushed none of them. It committed, then rebased onto origin; the
operator's machine had pushed a state snapshot eight seconds earlier touching
the same generated paths, so the rebase conflicted — and rebasing generated
files is meaningless anyway, since git cannot merge two machines' versions of a
computed report. Worse, the conflict left unmerged files in the tree, so
attempts two through four failed on *that* rather than on the race they were
written to survive; the retry loop could not have worked. And `sleep` exits 0,
so forty seconds of failure left the step green. Each attempt now fetches,
resets hard onto origin's tip, restores only the paths this run changed — the
operator's own snapshot survives untouched — and pushes; four failures exit 1
with an annotation. Verified against two scratch repositories reproducing the
real race.

This is the third silent-failure of the same family: `Math.min(...closes)`,
`prints.push(...day)`, and now a publish that fails green. The pattern is not
carelessness at the call site, it is that **this loop has no observer**, so
anything that fails quietly fails for as long as nobody happens to look. The
arg-spread check caught a fourth instance today *before* it shipped, in code I
wrote an hour earlier. That check is worth more than the bug it was written for.

**Where the number lands, honestly.** On the delayed entry the edge is 16.06bp
against a bar that starts at 7.48bp, so $10,000 clears by about 5bp and earns
roughly $5 a round trip — 60 of them a day for $300. $25,000 no longer pays.
Both $50,000 and $100,000 are now refused outright rather than priced, because
13% of their minutes ran off the end of the published curve and the median of
what survives is the book on its good days.

Still nothing to arm. The model prices resting depth, and resting is not
available.

## 2026-09-25 — the model was checked against reality, and survived at the end it was expected to fail

The largest stated caveat on this project's only real number was that
`sweep-impact` prices *resting* depth: quotes are pulled as an order arrives, so
a book showing $25,000 within 1% does not fill $25,000 within 1%. Every entry
since has repeated that the real knee must therefore be **lower** than $10,000,
not higher.

It is measurable without a live connection, and nothing had measured it.
aggTrades records orders that really executed with the side that crossed, so
consecutive one-sided prints inside 250ms are one order walking the book: the
notional it lifted and the distance it moved are both on the tape. 380,411
bursts out of 2.1M prints over three days.

| size | modelled | realised move | reverting part | bursts |
|---|---|---|---|---|
| $1,000 | 0.18bp | 0.81bp | 0.00bp | 354,033 |
| $5,000 | 0.88bp | 4.33bp | 0.96bp | 19,678 |
| $10,000 | 1.77bp | 6.43bp | 1.55bp | 4,520 |
| $25,000 | 4.42bp | 8.47bp | 2.16bp | 1,674 |
| $50,000 | 8.31bp | 10.86bp | 5.42bp | 385 |
| $100,000 | 22.85bp | 12.58bp | 8.45bp | 121 |

**The expected failure did not happen, and something else did.** The modelled
curve is nearly linear in size; the realised one is strongly concave — 0.81bp at
$1,000 rising only to 12.58bp at $100,000, where the model charges 22.85bp. A
book deep enough to be modelled linearly is not the book real sweeps meet: real
sweeps meet a book that refreshes. So at the large end the resting-depth model
is **conservative**, not optimistic, which is the opposite of what four entries
have asserted.

At the small end it is optimistic, by a factor of four. But the whole move is
not a cost. Split out the part that reverts within a minute — the push you
apply and the book takes back, which is what a round trip pays twice — and the
two curves agree closely at $5,000 and $10,000 (0.96 against 0.88, 1.55 against
1.77) and the model is dearer above that. The remainder is information: a trader
who sweeps $50,000 usually has a reason, and price staying moved is that reason
becoming public, not a cost of consuming depth.

**So the honest answer is a bracket, and it is wide.** On the delayed entry,
edge 16.06bp against a 7.48bp base:

- If a trade pays the **whole move** a real sweep of its size made: only ~$1,000
  survives, at about $0.70 a round trip. $300/day would need 429 of them, and a
  five-minute decile signal fires perhaps 144 times. **Not reachable.**
- If it pays only the **reverting part**: $10,000 nets 5.48bp for $5.48 a trip
  (55/day), $25,000 nets 4.26bp for $10.65 (29/day). **Reachable.**

Neither bound is the answer. A mechanical decile signal carries no private
information, so it should not pay the whole move; but `takerRatioFade` is a
*flow* feature, so its fires arrive precisely alongside informed sweeps, and it
will not pay only the revert either. Where it lands inside that bracket decides
whether this is a business or an arithmetic exercise, and nothing measured so
far distinguishes the two.

FINDINGS now prints both bounds beside the modelled table, so no future pass
quotes the middle column as if it were settled.

**What this retires and what it opens.** Retired: the claim that the knee is
lower than modelled — measured on executions it is not, at any size above
$5,000. Opened, and now the sharpest question in the project: how much of the
realised move does an uninformed order actually pay? The next measurement is to
split bursts by whether price stayed moved, and ask whether bursts arriving
*during* a `takerRatioFade` decile minute revert more or less than average. That
is the same archive, the same three days, and it answers the bracket directly.

Still nothing to arm.

## 2026-09-25 (later) — the bracket resolved, against the strategy

The sizing table ended with a bracket and a question: does a mechanical order pay
the whole move a real sweep makes, or only the part that reverts? $25,000 pays
handsomely under one and loses badly under the other, so the question was the
whole ballgame.

`takerRatioFade` is a flow feature — it fires on minutes where aggressive volume
is lopsided — and the taker ratio per minute comes off the same tape the bursts
do. So the sweeps arriving inside the finding's own minutes can be separated
from the rest and their reversion compared. 380,411 bursts, 53,098 of them in
the extreme decile minutes.

| | revert at 1m | revert at 5m | median move |
|---|---|---|---|
| extreme-flow minutes (where it fires) | 10.0% | **0.0%** | 1.38bp |
| every other minute | 17.6% | 11.8% | 1.45bp |

**The first reading was nearly a mistake worth recording.** At one minute the
extreme minutes revert less than ordinary ones, which reads as "those minutes
are informed, charge the whole move" — and charging the whole move kills every
size above $1,000. But that double-counts: `takerRatioFade` *is* the claim that
lopsided flow fades over five minutes. Charging the full move as a cost while
booking the edge from that same move reversing counts the same basis points
twice, once against and once for. The settle horizon has to match the horizon
traded, so it now measures both.

**Matching the horizon made it worse, not better.** At five minutes the median
sweep in the finding's own minutes reverts **zero** — the push does not come
back at all, and it comes back less than in ordinary minutes. The cost of
walking the book in exactly the minutes this strategy wants to trade is
permanent at the horizon it holds.

That resolves the bracket to the pessimistic column. Only ~$1,000 clears, at
about $0.72 a round trip, so $300/day needs 416 trips against a five-minute
decile that offers perhaps 144. **The taker version of this does not reach the
goal at any size the book supports.** Not "needs tuning" — the arithmetic is
closed.

**A tension worth naming rather than smoothing.** These two measurements point
opposite ways on similar objects: the minute-level decile says price *fades*
lopsided flow over five minutes, and the burst-level measurement says an
individual sweep inside those minutes *continues*. Both can hold — the
aggregate imbalance and one participant's sweep are not the same object — but
one of them is wrong about something, and a pass that wants to overturn this
verdict should start there rather than re-running the ladder.

**What survives.** Every basis point of cost measured here is the cost of
*crossing*. Impact is what an aggressor pays to consume depth; a resting order
consumes none and pays none of it. The settled list already contains
"cost-reduction — REJECTED", but that rejection was about fees on a two-cent
gross edge, which is a different claim from this one: here the gross edge is
15bp and the thing eating it is impact, which resting removes outright rather
than discounts. The maker path is now the only route to the goal that the
measurements have not closed, and the project has known since August that
`canPostEntry` has never once allowed a maker fill.

That is the next work, and it is not a research question — it is a defect.

Still nothing to arm.
