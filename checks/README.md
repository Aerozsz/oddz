# Check suites

Sixty-four standalone assertion files, one per defect class. They were written
in a scratch directory outside the repository, which meant every one of them
would have been lost with the session that produced them — so they are here now.

They are not a framework. Each file is a program that imports the real module,
constructs the situation that once broke it, and exits non-zero if it breaks
again. There is no runner to learn and no configuration.

## Running them

```
for f in checks/*-check.ts; do npx tsx "$f" || echo "FAIL $f"; done
```

Some boot a real control server against a temporary directory and take about
twenty seconds each; the whole set takes a few minutes. They set
`SWEEP_SNAPSHOT`, `SWEEP_LIMITS`, `SWEEP_DESIRED` and friends to temporary paths
so a test run cannot touch the live agent's state — that isolation was added
after a suite overwrote `evidence/snapshot.json`, and after the repository's own
`control/limits.json` reached into a test and zeroed the settings it was
asserting.

## Why they read the way they do

Every one exists because something silently produced a plausible wrong number.
The comments name the incident rather than the rule, because the rule is
forgettable and the incident is not:

- `entry-price-check.ts` — `entryPrice` was 0 on 25 of 27 records, so expectancy
  ran on 2 trades and every loss was filed as a patience problem
- `backtest-check.ts` — two symbols in one directory produced a 271,000-sigma
  "finding" that was two price scales in one array
- `shadow-summary-check.ts` — a field nobody assigned made four depth buckets
  read 0.0000, which is a finding, when it meant no data, which is a defect
- `hold-churn-check.ts` — the depth-expiry rule closing five trades in under
  four minutes each, on noise larger than the signal it traded
- `clock-check.ts` — a drifted clock rejecting every order below the strategy,
  so nothing was tallied as a refusal and the agent looked healthy and idle
- `process-tree-check.ts` — killing a shell on Windows and orphaning the node
  process under it, which holds the port the replacement needs

If you change one of these modules and its check fails, read the comment before
deciding the check is wrong. Twice it was the check that was stale. Every other
time it was right.
