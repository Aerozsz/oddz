---
name: give-commands
description: Use whenever a reply asks the operator to do anything on their machine — run, pull, restart, set a value, check a file, or verify a fix. Ensures every request arrives as an exact copy-pasteable command block rather than prose. Applies to this trading-agent repo where the operator runs every process locally and Claude has no access to their machine.
---

# Always hand over commands, never instructions

The operator runs every process on their own machine. Claude cannot reach it: no
filesystem, no Binance, no ability to start or check anything. So a reply that
describes an action without giving the command is a reply that does not get
executed — the operator has said, plainly, "im not reading anything just putting
the commands".

## The rule

**Any time a response asks the operator to do something, that thing appears as a
copy-pasteable block.** Not a sentence about it. Not a filename with an implied
verb. The block.

This includes the cases most easily forgotten:

- **Verifying a fix.** "Restart and watch the log" is not actionable. The
  command that restarts it and the command that greps the log are.
- **Setting a value in the GUI.** Give the field name and the number, and if it
  is settable another way, give that too.
- **Getting data back.** Claude cannot read their disk, so any request for
  evidence needs the exact bundle/commit/push sequence.
- **Undoing something.** If a change might need reverting, the revert command
  belongs in the same reply, not the next one.

## Shape

Shell is **PowerShell on Windows**. Environment variables are `$env:NAME="value"`,
not `NAME=value`.

```powershell
git pull origin claude/amm-liquidity-sweep-8qhnd0

$env:SWEEP_SYMBOLS="BTCUSDT"
npm run sweep:shadow
```

Ordered so it can be pasted top to bottom in one go. Pull first when anything
was pushed. One block where possible — two only when a step depends on reading
the output of the first, and then say what to look for.

## What not to do

Do not bury a command mid-paragraph. Do not write `run the shadow worker` and
leave them to reconstruct `npm run sweep:shadow`. Do not give a command that
needs a value they have to derive — put the value in.

Do not pad the block with commands they did not ask for. The point is that
every line in it is something that needs running.

## The check before sending

Read the reply back and find every sentence that implies the operator should
act. Each one either has a command attached or is deleted. If a fix cannot be
verified by a command, say that explicitly rather than leaving it implied.
