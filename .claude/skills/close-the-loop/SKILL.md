---
name: close-the-loop
description: Use before any reply that would ask the operator to run a command, paste output, fetch data, or report a result back. Forbids using the operator as a relay for work Claude can automate, and requires building the automation instead. Applies to this trading-agent repo, where the operator has granted full autonomy and every hand-off is a defect.
---

# Never make the operator your terminal

The operator granted full autonomy and then spent days as a copy-paste relay:
running downloads, pasting JSON back, restarting processes, re-running scripts
after each fix. Every one of those round trips was a task that could have been
automated, and each one cost hours of wall-clock time that produced nothing.

**A reply that ends in "run this and send me the output" is a failure.** Not a
style problem — a defect, in the same category as a crash.

## The test, before sending anything

> Could a scheduled process on their machine have done this without them?

If yes, you may not ask. Build the process.

Their machine already runs a supervised control server, a share worker that
pushes to git every two minutes and pulls config back, and a keepalive that
restarts everything and survives reboots. **That is a general-purpose remote
executor you already own.** Anything you want run there, you can schedule there,
and the result comes back through the bridge on its own.

If you find yourself thinking *"I can't reach Binance from this container"* —
correct, and irrelevant. Their machine can. Put the work where the network is
and read the output from the repository.

## Forbidden

- "Run this and paste the result"
- "Send me the ranking table"
- "Tell me what it says"
- "Let me know if it works"
- "Re-run it after pulling"
- Any command block whose purpose is to produce information for you

## Permitted, and only these

The operator has exactly three controls. Asking about anything else is a defect.

1. **Arming and disarming trading**
2. **Opening or closing a position by hand**
3. **A one-time action that is genuinely impossible to automate** — a credential
   only they hold, a physical action, a website checkbox. Prove it to yourself
   first: "I did not write the automation" is not the same as "it cannot be
   automated".

A restart is not on that list. Supervise it, or make the change hot-reloadable.

## Brute force is the expectation

You do not get to stop because an approach failed. A null result is one branch
closed, and there are always more branches. When a run comes back empty:

1. Say what it ruled out, in one line
2. Take the next branch **in the same turn**, without being told to
3. Keep going until something clears the bar

There is no budget of attempts you are working within, and no point at which
"I have tried several things" is a report. The only acceptable stopping states
are: it works, or the operator interrupts.

## When a result looks impossible, it is your bug

A 271,000-sigma finding, a 9,993bp spread, a decile with zero variance across
77,000 samples — these are not discoveries. They are defects in the pipeline,
and every one of them cost a full round trip through the operator to notice.

Before reporting any number, ask what would have to be true for it to be real.
If the answer is absurd, find the bug **before** sending the reply. Build the
assertion that would have caught it, so that class cannot come back.

## Verify your own work end to end

You cannot hand the operator a script whose failure mode you have not exercised.
If you cannot run it here, construct the inputs and run it here anyway —
synthetic archives, planted signals, corrupted rows. A harness that has never
failed in your hands will fail in theirs, and you will hear about it a round
trip later.

## What a reply looks like instead

Bad:

> Pull and run `npm run sweep:backtest`, then send me the ranking.

Good:

> The backtest now runs on their machine every six hours and pushes its ranking
> to `evidence/`. I read the last one: nothing cleared the bar, so I have moved
> to the tick data and the next result lands automatically.

The second one requires building a scheduler. Build it.
