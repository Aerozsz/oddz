# Handover — sweep trading agent

Branch: `claude/amm-liquidity-sweep-8qhnd0` (merge target: `claude/refactor-project-structure-JIiXS`)
Everything below is pushed and `npx tsc --noEmit` is clean.

---

## 1. What this is

An automated trading agent for Binance USDⓈ-M perpetuals built on a liquidity-sweep
thesis: find price levels where leveraged positions will be liquidated, detect when
resting depth is *withdrawn* (cancelled) rather than *consumed* (traded), and trade the
cascade toward the cluster.

**Operator goal:** $500–1000/day on a ~$5,000 account. Primary symbol **INTCUSDT**
(Nasdaq session model). BTCUSDT and crypto majors are for plumbing/evidence only.

**Operator's real trade profile** (measured, use these to calibrate — do not assume
smaller): 0.165–0.287% price moves, $81k–$148k notional, 16–30× leverage, holds of
17m to 4h21m.

### Standing constraints from the operator

- **Do not touch the Nasdaq/INTC session model** (`lib/sweep/metrics/session.ts`). They
  interrupted a previous change to it. BTC is testing only.
- They want **balanced risk, not conservatism**. Direct quote: *"we're here to make money
  not to net a savings account income, kill this logic of yours right now."*
- **`maxDailyLossUsd`, `lossCooldownMin`, `maxTradesPerDay` are deliberately disabled/relaxed**
  to maximise data collection. The auto-tuner is forbidden from touching them.
- They want things **working and turnkey**, not comprehensive. *"I want it ready/key in hands."*
- Always give the **pull command and run command** in replies.

---

## 2. Architecture — the four loops

```
                    ┌─ production fapi.binance.com (market data, ALWAYS real)
                    │
   engine.ts ───────┴──► AgentState ──► signals ──► bias ──► sizing ──► adapter ──► orders
      │                      │                                              │      (demo unless
      │                      │                                              │       BINANCE_LIVE=1)
      │                      ▼                                              ▼
      │              captureConditions()                            classifyConstraint()
      │                      │                                              │
      ▼                      ▼                                              ▼
 participants        sweep-trades.jsonl  ◄── postmortem (MAE/MFE)    constraint memory
 markout, funding             │                                              │
 clusters, cascade            ▼                                              ▼
                        learn.ts (analyse)  ────────────────────────► autotune.ts
                              │                                              │
                              └──────────► sweep-tuning.jsonl ◄──────────────┘
                                              (append-only audit + undo)
```

**Loop 1 — outcomes.** Closed trade → post-mortem → `analyse()` → `proposeTuning()` → caps move.
**Loop 2 — constraints.** Venue rejection → `classifyConstraint()` → immediate retry or halt → repeats move caps.
**Loop 3 — shadow.** Signals → priced intents → scored against real price. **Partially wired — see TODO 1.**
**Loop 4 — Hermes (MCP).** Reads live state, writes news/events. **Not wired to learning — see TODO 3.**

---

## 3. Key modules and the reasoning in them

Every file has a long header comment explaining *why*, not just what. Read those first —
they carry the design rationale and the mistakes already made and corrected.

| File | Purpose |
|---|---|
| `lib/sweep/agent/evidence.ts` | **The admissibility rule.** Shadow rows may answer price questions, never fill questions. Enforced, not documented. |
| `lib/sweep/agent/postmortem.ts` | `TradeRecord`, `EntryConditions` (~35 bucketable fields), `Excursion` (live MAE/MFE tracker). |
| `lib/sweep/agent/learn.ts` | Wilson intervals, Bonferroni-corrected splits, 4-way loss taxonomy, recommendations. |
| `lib/sweep/agent/autotune.ts` | Bounded cap changes. Bounds / step limits / trade-spacing / hysteresis / rotation. |
| `lib/sweep/agent/profit.ts` | Trailing stop, scale-out, target extension. |
| `lib/sweep/agent/hold.ts` | Adaptive hold time from thesis health, not a clock. |
| `lib/sweep/agent/sizing.ts` | Fixed-fractional. `notional = riskUsd / stopPct` — **leverage is derived, never chosen**. |
| `lib/sweep/exchange/constraints.ts` | Every Binance rejection code → action + whether repeats move a cap. |
| `lib/sweep/exchange/adapter.ts` | Order path. Margin headroom, constraint-aware retry. |
| `lib/sweep/metrics/participants.ts` | Behavioural forensics: replenish speed, icebergs, slice uniformity, **aggressor bursts**. |
| `workers/sweep-control.ts` | ~5000 lines. Control server + GUI. Desk-per-symbol. |

### Non-obvious invariants — do not break these

1. **Market data is always production**, orders go to demo unless `BINANCE_LIVE=1`.
2. **The stop only ever moves toward the position.** 400-random-walk test asserts it.
3. **Widening the stop does not increase risk** — the sizer divides the same risk by the
   wider distance, so the position shrinks proportionally.
4. **Absent `source` on a TradeRecord means `"live"`** — correct for all rows already on disk.
5. **Auto-tune makes at most one change per pass**, or changes can't be attributed.
6. **`marginHeadroomPct`** exists because `notional = equity × leverage` is *exactly* the
   most an account can fund, so the opening commission made every max-size order reject (-2019).

---

## 4. Verification

```bash
npx tsc --noEmit
npm run sweep:guicheck          # GUI script parses
DATABASE_URL="postgres://u:p@localhost:5432/d" CRON_SECRET="0123456789abcdefghij" npx next build
```

**Tests live in the scratchpad, not the repo** (`/tmp/claude-0/-home-user-oddz/<session>/scratchpad/*.ts`).
They will not exist in a new session — **you may need to rewrite them.** Run with `npx tsx <path>`
from the repo root (they use `@/` path aliases). ~31 suites, all passing at handover.

The load-bearing ones worth recreating first:
- `learn-check` — 40 random trades across 20 randomised fields must yield **zero** findings.
- `tune-check` — 300 random batches never escape bounds; 10 contradictory batches never oscillate.
- `profit-check` — 400 random walks never loosen the stop.
- `constraint-check` — only sizing faults are answered by sizing.

---

## 5. Current state

- **Testnet: −$1k.** Largely meaningless — demo has no real microstructure. The MAE/MFE in
  those records is real (production feed); the PnL is not.
- **Forensics working:** book, withdrawal decomposition, participants, aggressor bursts,
  liquidations, mark-out, funding, session, cascades, dislocation.
- **Forensics missing:** social media (zero code), news auto-fetch (store exists, no fetcher).
- Auto-tune is **off by default** (`limits.autoTune`).

### Power analysis (why this matters)

| Goal | Trades needed |
|---|---|
| Prove profitability (+0.3R edge) | 97 |
| Find a 1R conditional edge | 91 |
| Find a 0.5R conditional edge | 361 |

At 2–4 live trades/day that's months. **Shadow mode is the only way to compress it** —
it collects at the signal rate, unthrottled by trade caps.

---

## 6. TODO — in priority order

### 1. Finish wiring shadow into the learning pool ← START HERE
`evidence.ts` has `shadowToRecord()` and the admissibility rule. Still missing:
- `workers/sweep-shadow.ts` must call `captureConditions()` and store it on the trade
  (`ShadowTrade.conditions`), and write `high`/`low` from its pending map into the row.
- Something must convert scored shadow rows into `TradeRecord`s and append them to the
  pool that `loadTrades()` reads (either write both files, or have `loadTrades()` merge).
- Verify: run `npm run sweep:learn` and confirm shadow rows appear in the anatomy/splits
  but are **excluded** from win rate and expectancy (the caveat text should say so).

### 2. `sweep-mcp.ts` is single-symbol
It imports `SYMBOL`, not `SYMBOLS` — same bug just fixed in the shadow runner. Hermes
only ever sees the first contract. Fix the same way (desk per symbol).

### 3. Give Hermes read access to the evidence
Add MCP tools: `sweep_trades`, `sweep_shadow`, `sweep_learn` (returning `analyse()` output),
`sweep_tuning`. Right now Hermes can see live market state and *write* news, but cannot
read any recorded evidence — so it cannot review its own performance. This is what the
operator means by "link everything together".

### 4. Automated news/social fetching
The operator explicitly wants external data fetched automatically. Two options:
- **Hermes does it** (it has web search + content extraction) — needs a schedule/prompt,
  and `sweep_record_news` already exists for the write path. Cheapest.
- **A fetcher worker** — RSS from Coindesk/Cointelegraph/Binance announcements, no API key.
`EntryConditions.newsImpactMax / minutesSinceNews / newsCount6h` are already in place and
will start carrying signal the moment anything populates the store.

### 5. Automated review
Nothing runs `analyse()` on a schedule and reports. Consider a worker or a Routine
(`create_trigger` via the claude-code-remote MCP) that runs the post-mortem daily and
surfaces findings.

### 6. Operator's outstanding manual steps
- Set **Stop distance 0.2** and **Max leverage 20** in the GUI (matches their real profile).
- Sign the **INTCUSDT TradFi perps agreement** on the live account (error `-4411`).

---

## 7. Commands

```bash
git pull origin claude/amm-liquidity-sweep-8qhnd0

npm run sweep:control      # control server + GUI (token printed at startup)
SWEEP_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT npm run sweep:shadow
npm run sweep:learn        # post-mortem report
npm run sweep:learn -- --trades
npm run sweep:check        # credential/venue diagnostic
npm run sweep:mcp          # MCP server for Hermes
```

Data files (gitignored, on the operator's machine — **you will not have access**):
`data/sweep-trades.jsonl`, `data/sweep-shadow.jsonl`, `data/sweep-tuning.jsonl`,
`data/sweep-positions.json`, `data/sweep-limits.json`, `data/sweep-news.jsonl`.

To analyse their real data, ask them to commit the `.jsonl` files or paste
`npm run sweep:learn` output.

---

## 8. Working style that has been effective

- **Long "why" comments.** The operator values reasoning captured in the code.
- **Write the adversarial test first.** Several real bugs were caught only by tests
  designed to prove the code *wrong* (the noise test, the monotonicity walk, the
  bounds fuzz).
- **Calibrate to their real numbers.** Two separate bugs came from thresholds set above
  their actual 0.165–0.287% edge (`minRewardOverFees: 3`, scale-out fee gate at 3×).
  Check any new threshold against that range.
- **Be direct about what doesn't work.** They respond well to plainly-stated gaps and
  badly to overclaiming — the social/news gap should have been flagged when built.
