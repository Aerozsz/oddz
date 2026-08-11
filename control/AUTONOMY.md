# Operating procedure for an unattended session

You have been woken by a schedule, not by a person. The operator is not
watching and has asked for the loop to run without them. They keep exactly
three controls — arming, disarming, and opening or closing positions by hand —
and everything else is yours.

Read this whole file before touching anything.

## The goal

Consistent net profit on the sweep agent, working toward $300+/day. That goal is
not in question and is never reported as unreachable — see the
`exhaust-solutions` skill, which is binding here. Your job is to find the next
lever and pull it, every time you run.

## What you must do each time you wake

**1. Read the run.**

```bash
git fetch -q origin claude/amm-liquidity-sweep-8qhnd0
git show origin/claude/amm-liquidity-sweep-8qhnd0:evidence/snapshot.json
```

That file carries: status, limits, refusal tally, the post-mortem, the last 200
log lines, any captured error, the operator's notes, and `diagnose` — the
self-check that names what is broken and its specific fix. Start there.

**2. Check the bridge is alive before believing anything.**

Compare `meta.at` against now. A snapshot older than about twenty minutes means
the run is not being reported, and every number in it describes a past that may
no longer exist. Say so plainly rather than analysing stale state — this has
already happened once, and nine hours of a live run were invisible.

**3. Act.**

In descending order of what usually matters:

- **Anything in `errors`, or a `bad` in `diagnose`.** Fix it. These are
  concrete and do not need a sample size.
- **A refusal reason with a large count.** Every one of these has been a bug so
  far, not a market condition: a trade cap that was switched off, an hourly
  ceiling floored at 2, a target gate nobody chose. Read the number, find the
  code, check whether the operator asked for it.
- **The learning loop, once `learn.n >= 20`.** Below that, do not touch entry
  logic — you will be fitting noise, and doing so has already cost this project
  a day. Fee-path and mechanism work is exempt: it does not depend on sample size.
- **The operator's notes.** They come through in `notes`, each carrying the
  state at the minute it was written. Answer them by appending to
  `control/replies.jsonl` — see below.

**4. Push, so it reaches the machine.**

Config goes in `control/limits.json` with a fresh `at` timestamp:

```json
{ "at": 1786400000000, "reason": "why", "limits": { "stopLossPct": 0.25 } }
```

The control server applies it within twenty seconds. It cannot arm, disarm,
touch a position, or re-enable the three stopping rules — those are refused by
name, which is intentional and must not be worked around.

Replies to the operator go in `control/replies.jsonl`, one JSON object per line:

```json
{"at": 1786400000000, "from": "claude", "text": "..."}
```

Never write `data/sweep-messages.jsonl` — that is the operator's outbox and
writing it causes the conflict the two-file split exists to prevent.

**5. Verify before pushing code.** Non-negotiable:

```bash
npx tsc --noEmit && npm run sweep:guicheck
for f in <scratchpad>/*-check.ts; do npx tsx "$f" >/dev/null || echo "FAIL $f"; done
```

A push that breaks the control server takes the agent down until a human
notices, and no human is watching.

## Standing constraints

These come from the operator directly and are not yours to revise:

- **`maxDailyLossUsd`, `maxTradesPerDay`, `lossCooldownMin` stay at 0.** They
  were switched off deliberately to collect data. Three separate code paths have
  already put them back once against that decision.
- **Never touch `lib/sweep/metrics/session.ts`** — the Nasdaq session model.
- **Balanced risk, not conservatism.** The operator's words: *"we're here to
  make money not to net a savings account income."* A change that shrinks
  exposure needs the same evidential bar as one that raises it.
- **`0` means "no limit"** everywhere in this codebase. Three separate bugs have
  come from reading it as "zero allowed". Check for a fourth.
- **Never `git add -A`.** The operator keeps a credentials file in the working
  tree. Always pathspec.

## What to report, and when

Say nothing on a quiet pass. The operator is not watching and does not want a
heartbeat message.

Write a reply into `control/replies.jsonl` when, and only when:

- Something broke and you fixed it — say what and what changed
- You changed a setting — say which, from what to what, and why
- A result crossed a threshold worth knowing (first profitable day; 20 closes
  reached and the win rate is now readable; a loss run that is structural
  rather than statistical)
- They asked something in `notes`

## Continuity between passes

You start with no memory of the previous run. `control/JOURNAL.md` is the
memory — read the last three entries before doing anything, because they carry
intent and the snapshot only carries state. A pass that saw a refusal spike and
decided to wait for more data looks identical, from the snapshot alone, to a
pass that never noticed it.

Append one entry per pass, in the format that file specifies, **including passes
that changed nothing**. "Looked, nothing to do, waiting for n=20" is a useful
entry. Silence is not — the next session cannot tell it from a session that
never ran.

## The open questions, as of the last handover

Carry these forward and update them as they resolve:

1. **Is the entry gate working?** The bias now requires the side price must
   travel through to be genuinely below baseline, not merely thinner than the
   other side. Before that fix, 59 trades entered on books at 1.00–1.42x depth
   and won 3%. The question is whether entries now happen on thin books at all,
   and whether those win.
2. **The maker path.** 0 fills in 552 shadow trades. Worth ~$4.87 a round trip,
   ~$78/day at 16 trades — the largest single lever on the list. Gated on
   mark-out toxicity via `canPostEntry`. Mark-out warms correctly in isolation,
   so find out what the live number actually is.
3. **The accounting discrepancy.** The trade log said −$142 for six trades; the
   exchange ledger said −$63.44 for the same six. One is wrong, and the
   post-mortem drives learning while the ledger drives the caps.
4. **Fee load.** ~$13 a round trip at $16k notional. On a flat trade that is the
   entire cost. It is a multiplier on everything else, not a separate problem.
