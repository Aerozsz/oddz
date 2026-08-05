# Geopolitics / peace ↔ war monitor

An omnisourced, at-a-glance tracker for Trump's market-moving announcements,
built on a single bipolar axis: **escalation (war, risk-off) ↔ de-escalation
(peace, risk-on)**.

## Why

Trump moves markets with peace-vs-war headlines on a repeatable loop — so much
so that the flip-flop is now expected and priced. A ceasefire post lifts
equities and dumps oil; a strike threat does the reverse; a tariff line is the
trade-war version of the same move. The edge isn't any one post — it's reading
the **current tilt** across both sides at a glance, and knowing which theater
just moved. This dashboard exists to make that a two-second read.

## The UI, and why it's shaped this way

The ask was "lay out the UI/UX so it's easy to track *both sides*." So the page
is built around one bipolar axis, top to bottom:

1. **Tilt gauge** (the headline). A single red→green bipolar bar with a pointer
   at the recency- and intensity-weighted net of the last 48h. Left is
   escalation/risk-off, right is de-escalation/risk-on, center is balanced.
   Numeric tilt (−100…+100) and a plain-language label ("Leaning escalation").
   This answers "where are we right now?" before you read a single headline.
2. **Theater strip**. Six mini-gauges — Russia–Ukraine, Middle East,
   China–Taiwan, North Korea, Trade/Tariffs, Other — each showing that front's
   own tilt, counts, and last update. Click one to scope the whole page to it
   (the gauge and both columns narrow); click again to clear.
3. **Two columns, side by side**. Escalation (🔴 left) and De-escalation (🟢
   right), newest first, so both sides are literally in view at once — never one
   feed you have to mentally sort. Each card carries intensity, theater, source,
   market lean (risk-off/on), time, and a "pushed" badge if it was notified.
4. **Mixed lane**. Headlines that carry both signals ("agrees to talks but
   warns of strikes") land here instead of being force-picked to a side — an
   honest bucket for genuinely ambiguous messages.

Everything on the page derives from one query (the last 48h of signals), so the
gauge, strip, and columns can never disagree with each other.

## How it works

```
lib/geo/
  types.ts     Side / Theater / Intensity + the GeoSource interface
  classify.ts  actor gate + escalation/de-escalation groups + theater + lean
  sources/     google-news.ts (Trump × theater × both sides), truth-social.ts
  notify.ts    escalation=red/risk-off, de-escalation=green/risk-on push
  monitor.ts   fetch → classify → dedupe → persist → notify (geo_signals)

features/geo/
  tilt.ts      pure, testable tilt + per-theater math
  queries.ts   the one windowed query the page reads

app/geopolitics/page.tsx     the two-sided dashboard
app/api/cron/geo/route.ts    auth'd tick (Bearer CRON_SECRET)
.github/workflows/geo-monitor.yml   drives it every minute
```

Shared with the INTC monitor: the RSS/Atom parser and feed fetch
(`lib/feeds/`), and the push channels (`lib/notify/channels.ts`). Same
isolation and exactly-once guarantees — a degraded source truncates only
itself, and the dedupe upsert's returning set is exactly the never-seen rows,
so a re-poll never double-pushes.

## The classifier

`classify.ts` scores the two sides independently and lets the dominant one win;
a near-tie is labeled neutral (→ the Mixed lane) rather than guessed.

| Side | Groups (weight) |
|------|-----------------|
| De-escalation | ceasefire/truce (5), peace deal/agreement (5), talks/diplomacy (3), sanctions relief/release (3), tariff pause/trade deal (4) |
| Escalation | strike/military action (6), threat/ultimatum (4), troops/deployment (4), new sanctions (3), nuclear (5), new/higher tariffs (4) |

Theater is matched by named entities (Putin/Zelensky → Russia–Ukraine;
Iran/Israel/Gaza → Middle East; Xi/Taiwan → China–Taiwan; Kim → North Korea;
tariff/trade → Trade). Market lean falls straight out of the side: escalation →
risk-off, de-escalation → risk-on.

## Sources

- **Google News RSS** — narrow queries around Trump × each theater × both sides.
  His Truth Social posts get reported by the wires within minutes, so this
  catches the market-moving (headlined) version almost as fast as the post,
  with no account.
- **Truth Social** — the raw feed, straight from the poster, via an RSS URL you
  point it at (`TRUTH_SOCIAL_RSS_URL`; a self-hosted bridge or hosted mirror).
  Unset → it no-ops and the wires carry the load.

## Notifications

Shares the INTC channels (`.env.example`): Telegram / ntfy / webhook. Only
signals that pick a side and clear `GEO_MIN_INTENSITY` are pushed — escalation
buzzes red at high priority, de-escalation green. Neutral/mixed items are
recorded for the dashboard but never buzz.

## Running it

```sh
DATABASE_URL=… npm run geo:once          # one-off, locally
# production: the geo-monitor workflow hits /api/cron/geo every minute.
```

Side and theater are inferred from headline text and can misread sarcasm or a
mixed message. Not investment advice.
