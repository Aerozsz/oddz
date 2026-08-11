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
