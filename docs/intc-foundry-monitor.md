# INTC foundry monitor

A real-time watch for the news that actually moves Intel stock — and only that
news.

## The thesis it encodes

Intel no longer trades off quarterly results. It beat earnings and fell anyway.
What drives the price is the **foundry** (IFS): a business doing $5.8B in
revenue but only ~$293M from *external* customers, against a $2.1B operating
loss, while capex runs north of $20B/year. The entire bull case is external
customers at volume, and the node meant to deliver them — **14A** — doesn't
reach high-volume production until 2028.

So the asymmetry is:

- **Repricing up** is *rare*: a named external customer committing to volume on
  **18A/14A**, a strategic anchor (a government stake, a capacity reservation),
  a de-risking milestone. These arrive infrequently.
- **Repricing down** is *frequent*: execution slips, capex blowouts, foundry
  P&L, yield problems, separation/divestiture headlines, sector selloffs.

You can't trade INTC off revenue forecasts. You trade it off *catalysts*, and
the catalysts land without warning. This monitor exists to catch them the
moment they cross the wire and push them to your phone.

## How it works

```
lib/intc/
  types.ts        the normalized item shape + NewsSource interface
  classify.ts     the foundry gate + severity + direction taxonomy (the thesis)
  rss.ts          dependency-free RSS/Atom parser
  net.ts          text-feed fetch with timeout + retry
  notify.ts       channel-agnostic push (Telegram / ntfy / webhook)
  monitor.ts      fetch → classify → dedupe → persist → notify
  sources/
    google-news.ts    narrow foundry queries over Google News RSS (fast, keyless)
    sec-edgar.ts      Intel 8-K/10-Q/10-K filings — the primary source
    intel-newsroom.ts Intel's own PR + IR releases

app/api/cron/intc/route.ts   auth'd tick (Bearer CRON_SECRET), same as snapshot
app/intc/page.tsx            live feed + monitor heartbeat
.github/workflows/intc-monitor.yml  drives the tick every minute
```

Each run: pull every source concurrently under a time budget (a degraded feed
truncates only itself), classify each item through the foundry gate, dedupe on
a deterministic `sha256(source|normalized-url)` via an `onConflictDoNothing`
upsert — so the *returned* rows are exactly the ones never seen before — then
push the new rows that clear `INTC_MIN_SEVERITY`. Exactly-once by construction:
re-polling the same headline never double-pushes.

## The classifier

`classify.ts` is a weighted keyword taxonomy. An item must clear two gates —
it's about **Intel** and about the **foundry** — or it's dropped. Then signal
groups fire:

| Direction | Groups (weight) |
|-----------|-----------------|
| Bullish   | external customer win (5), marquee customer named (4), government/strategic anchor (4), node milestone/progress (3) |
| Bearish   | execution slip/delay (5), customer loss/no demand (5), capex/foundry P&L (4), separation/divestiture (4), yield/defect (4), layoffs/restructuring (2) |
| Amplifier | 14A node (3), 18A node (2), analyst rating change (2) |

Severity comes from the summed score, floored high whenever a marquee group
(external customer, government anchor, customer loss) fires — those are the
whole reason the monitor exists. Direction is the net of bullish vs bearish
weight; genuinely mixed items stay neutral rather than guess a side.

Tuning is editing one table. Everything — weights, patterns, thresholds —
lives in `classify.ts`.

## SEC filings

`data.sec.gov/submissions/CIK0000050863.json` (Intel's CIK) surfaces 8-K,
10-Q, and 10-K filings minutes after Intel files them — often before the wires
write them up. An 8-K "Material Definitive Agreement" in the foundry era is
exactly the shape of a customer/anchor deal, so Intel's material 8-Ks are
surfaced even when the one-line metadata doesn't say "foundry" (the angle is
usually in the filing body). Hot 8-K item codes (1.01/1.02/2.02/2.05/2.06) are
floored to high severity.

## Notifications

Configure whichever channel you'll actually read (see `.env.example`). All are
optional and fired independently:

- **ntfy** — zero-account. Pick a topic, install the ntfy app, subscribe.
  Critical items ship at priority 5 so they buzz through a silenced phone.
- **Telegram** — a bot + chat id; the richest formatting.
- **Webhook** — Slack/Discord/Zapier/your endpoint. Payload carries `text`
  (Slack), `content` (Discord), and a structured `intc` object.

With no channel set, catalysts are still stored and logged — the `/intc` feed
and the JSON logs are the fallback record.

## Latency, honestly

The **notification** is instant once a run finds something. **Detection** is
bounded by the cron cadence: the GitHub Actions scheduler is best-effort and
coalesces under load, so `* * * * *` realistically fires every ~1–5 min. For a
harder floor, point Vercel Cron or an Upstash QStash schedule at the same
`/api/cron/intc` endpoint — no code changes.

## Running it

```sh
# one-off, locally
DATABASE_URL=postgres://... npm run intc:once

# production: the intc-monitor workflow hits /api/cron/intc every minute.
# Requires the repo Actions secret CRON_SECRET (= the Vercel env var) and,
# for pushes, a notification channel in the Vercel environment.
```

Not investment advice. A screening tool for catalysts, not a recommendation.
