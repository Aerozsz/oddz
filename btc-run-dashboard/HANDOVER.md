# BTC Triple Run dashboard: handover

A live monitor for one tracked BTC paper position. It streams Hyperliquid prices, checks a set of rules on every tick and every closed 1-minute candle, and tells the trader when something needs doing. It does not place or close trades. The venue (papertrade) fills at Hyperliquid's best bid/offer and has no TP/SL orders, so every close is a manual press of Close on the venue.

Origin: ported from a claude.ai artifact that read Hyperliquid through the Coinversa Pulse MCP connector. The trading rules and the engine are unchanged; the data layer was rewritten for a normal website.

## Start here (for Claude Code)

The code is complete and tested locally (`npm test` passes). It has **not** been deployed: the Vercel connector used to build it was refused permission to create projects (HTTP 403), and it has not yet run against the live Hyperliquid and Coinversa endpoints (the build sandbox had no outbound access to them). Steps:

1. `npm install && npm test` in this folder. All three test files must pass.
2. Deploy to Vercel team `aeriaszs-projects` as project `btc-triple-run`: `npx vercel link` (create the project, framework "Other", no build command, output directory `public`), then set the env vars:
   - `npx vercel env add DASHBOARD_KEY production` (a passcode the owner chooses)
   - `npx vercel env add COINVERSA_API_KEY production` (from coinversa.ai/developers, starts with `cvsa_`)
3. `npx vercel deploy --prod`.
4. Verify on the production URL:
   - `curl -s -H "x-dashboard-key: $KEY" "$URL/api/cv?route=plan"` returns the key's plan as JSON (401 means the passcode is wrong, 503 means the Coinversa key is missing).
   - `curl -s -H "x-dashboard-key: $KEY" "$URL/api/cv?route=heatmap&coin=BTC&range=5&buckets=80"` returns `buckets[]` with `low, high, longNotional, shortNotional`.
   - `curl -s -X POST -H "content-type: application/json" -H "x-dashboard-key: $KEY" -d '{"type":"candleSnapshot","req":{"coin":"BTC","interval":"1m","startTime":'$(($(date +%s)*1000-3600000))',"endTime":'$(($(date +%s)*1000))'}}' "$URL/api/hl"` returns about 60 candles.
   - Open the page, enter the passcode when asked, flip Monitoring on with no position: the Feeds panel should show the stream Live, bid/ask ticking, candles loaded, mark and oracle, taker flow, and the liquidation map filling in.
5. Check one assumption in a browser console while monitoring: in Hyperliquid `trades` messages, `side: "B"` should line up with prints at the ask (taker buys). If it's the other way round, flip the mapping in `onTrades` in `public/app.js`.
6. Optional: put the folder in a Git repo and connect it to the Vercel project so each push deploys.

## Using it

1. Open the site. Monitoring is **off** by default and nothing runs: no WebSocket, no API calls.
2. Fill in the position (side, open time, entry, bust, notional, margin, fee the venue nets, goal). Pressure and exit levels are optional; leave them empty to turn those two rules off. They can be edited while the position is open.
3. Press **Track position**, then flip **Monitoring on**. The page loads 1m candles from the open time (up to 5,000 minutes), checks them against the bust, then goes live.
4. Press **Turn on alerts** once per visit for sound and notifications (browsers require a click). On iPhone, notifications only work after "Add to Home Screen".
5. If the Feeds panel asks for the passcode, enter the `DASHBOARD_KEY` value. It is stored in that browser only.
6. Flip monitoring off when done. With a position open the switch asks for a second click. The monitoring state survives reloads.

## Files

| Path | What it does |
|---|---|
| `public/index.html` | Markup only. Loads the scripts below in order. |
| `public/styles.css` | All styles, light and dark tokens on `:root`. |
| `public/config.js` | Per-session settings: chart reference `LEVELS`, calendar `EVENTS` (UTC), poll intervals, alert thresholds, daily budget. **Update LEVELS and EVENTS before each session.** |
| `public/engine.js` | Pure trade math, no DOM: plan from manual inputs, bust/target checks per bar, driftless odds (`probTargetFirst`), expected time, level crossings. Tested in `test/engine.test.cjs`. |
| `public/feeds.js` | Every network call. Hyperliquid WebSocket, Hyperliquid candle history, Coinversa polling through `/api/cv`. No DOM; talks to the page through callbacks. |
| `public/app.js` | State, rules, rendering. Sections are marked with `// -----` headers. |
| `public/sw.js` | Service worker used only for notifications (Android needs one). Caches nothing. |
| `public/layout.js` | Movable, resizable panels (GridStack, vendored in `public/vendor/`). Locked until **Edit layout**; saved per browser in `btc-run-layout-v1`; one stacked column under 760px. |
| `public/chat.js` | The **Ask Claude** panel. Sends `window.__btcRun.snapshot()` with each message to `/api/chat`, streams the answer, keeps chats per browser in `btc-run-chats-v1` (history stored exactly as the server returned it, append-only). |
| `api/chat.js` | Claude chat route. Holds `ANTHROPIC_API_KEY`. Model `claude-opus-5-5`, effort medium, server-side refusal fallback, tools: liquidation map and fills (Coinversa), Hyperliquid candles, web search. Streams NDJSON. |
| `api/cv.js` | Coinversa proxy. Holds `COINVERSA_API_KEY`, allows three routes, validates params, caches 5 to 60 s per route, forwards `x-ratelimit-*` headers. |
| `api/hl.js` | Hyperliquid `candleSnapshot` proxy, used only if the browser can't call Hyperliquid directly. |
| `api/_auth.js` | Passcode check (`x-dashboard-key` header vs `DASHBOARD_KEY`) and JSON response helper. Underscore files are not routes on Vercel. |
| `vercel.json` | Static output dir `public`, security headers and CSP, no-cache on scripts. |

## Data sources

**Hyperliquid WebSocket** `wss://api.hyperliquid.xyz/ws`, public, no key. Subscriptions sent on open:
- `{type:'bbo', coin}`: best bid/ask, the price the venue fills at. If no `bbo` message arrives within 8 s the page also subscribes `l2Book` and uses its top level.
- `{type:'candle', coin, interval:'1m'}`: trade OHLC. The forming bar keeps the book's close (the ask for a short) and widens to the candle's high/low so the bust check sees every trade.
- `{type:'activeAssetCtx', coin}`: `markPx` and `oraclePx`. Checked once a second for mark at bust, mark vs book gap > 0.15%, mark vs oracle gap > 0.2%.
- `{type:'trades', coin}`: grouped by transaction hash to size each taker order. `side` `B` is treated as a taker buy and `A` as a taker sell. **Assumption to verify** against the Hyperliquid UI tape.
- Ping every 30 s; a watchdog reconnects after 20 s of silence; exponential backoff to 30 s.

**Hyperliquid REST** `POST https://api.hyperliquid.xyz/info` `{type:'candleSnapshot', req:{coin, interval:'1m', startTime, endTime}}`, max 5,000 candles. Tried from the browser first, then `/api/hl`.

**Coinversa** `https://api.coinversa.ai/api/public/v1`, header `X-API-Key: cvsa_...` (keys from coinversa.ai/developers; plan limits apply per key). Only through `/api/cv`:
- `route=heatmap` → `GET /live/liquidation-heatmap/{coin}?range=5&buckets=80`. `range` must be a whole number. Every 120 s. Response `buckets[]` with `low, high, longNotional, shortNotional`. It is a model of where open positions would be liquidated, refreshed by Coinversa every few minutes.
- `route=liquidations` → `GET /live/risk/liquidations/recent?coin=BTC&since=3m&limit=200`. Every 30 s. Events are **fills** (one large liquidation can be 100+ fills from one wallet) with `timestampMs, address, liquidator, penaltyFee, closedPnl`; no side or size. The cap of 200 can be hit in one burst.
- `route=plan` → `GET /plan` (not polled; handy for checking a key).
- Budget: about 3,600 calls a day while monitoring. Calls are counted per browser per UTC day; polls slow 2x past 17,000 and stop past 19,000 (`CONFIG.BUDGET`).

## Environment variables (Vercel project settings)

| Name | Required | Purpose |
|---|---|---|
| `DASHBOARD_KEY` | yes in production | Passcode for `/api/cv` and `/api/hl`. Without it those routes are open to anyone with the URL. |
| `COINVERSA_API_KEY` | for the liquidation features | Coinversa REST key. Without it the map and liquidation feeds show "Not set up"; everything else works. |
| `COINVERSA_API_URL` | no | Override the Coinversa base URL. |
| `ANTHROPIC_API_KEY` | for the chat | Anthropic API key from console.anthropic.com (billed per use, separate from a Claude plan). Without it the chat panel says it is not set up. |

Environment variable changes need a redeploy to take effect.

## Rules (where they live)

Grades: `watch` = HEADS-UP (no action), `prepare` = GET READY, `act` = ACT NOW. `raiseAction(id, text, level, kind)` dedupes by id; watches and some get-readies expire after 15 minutes.

- Per tick (`runStep`, `onMark`): target through on the close side → ACT NOW press Close; within 0.1% or a wick tag → GET READY; bust on candle high/book or on mark → ACT NOW.
- Per closed 1m candle (`assess`): pressure/exit levels; fast 3-minute move scaled to the hour's median range; scheduled release reaction; volatility jump; tight 30-minute squeeze; approach to a ≥$5M bust-side cluster within 0.3%; ≥$20M of fuel to target with a 15-minute lean; squeeze early-cut (past pressure, burst or shock toward bust within 3 minutes, ≥$5M fuel to bust).
- Feeds: taker orders ≥$2M (heads-up) and ≥$5M toward bust (get ready, also counts as a burst for the squeeze cut) in `onTrades`; liquidation bursts with side read from the map (`burstSide`) in `onLiqs`; clusters used up between two maps in `checkUsedUp`.

## Liquidation map panel

`renderMap()` shows fuel between price and target (favourable side) against fuel between price and bust (adverse side), with a balance bar, the change since the previous map, and the nearest and biggest cluster on each side. With no position it shows longs below and shorts above within the map range. `fuelBetween()` counts only the overlapping part of edge buckets. A cluster is a run of adjacent buckets of ≥$1M totalling ≥$5M (`CONFIG.CLUSTER`).

## State

`localStorage` per browser: `btc-run-dashboard-v1` (position, actions, log, last 300 bars, monitoring flag), `btc-run-passcode`, `cv-calls-YYYY-MM-DD`. Nothing is stored server-side. Two devices do not share state.

## Tests

```
npm install
npm test
```
`test/engine.test.cjs` (trade math), `test/api.test.cjs` (both functions with mocked upstream), `test/chat.test.cjs` (chat route with a fake Claude client, chat panel in jsdom), `test/app.test.cjs` (whole page in jsdom with a fake WebSocket and mocked fetch: off by default, gap replay, stream, map, taker print, used-up cluster, target, off switch, proxy fallback, passcode prompt, resume on reload).

## Deploy

Vercel team `aeriaszs-projects`, project `triplerun` (https://triplerun.vercel.app), root directory `btc-run-dashboard` of `Aerozsz/oddz`, install `npm install`, no build step (`outputDirectory: public`). `api/chat.js` runs up to 300 s. From this folder: `npx vercel deploy --prod`. Connecting a Git repository to the project makes every push deploy.

## Known limits

- The page only monitors while it is open somewhere. Background tabs keep the WebSocket, but a sleeping phone or laptop stops everything. Server-side monitoring would need a long-running worker (Vercel functions are request-scoped; Vercel Cron's per-minute schedule is a paid-plan feature and still can't watch ticks).
- The liquidation map is Coinversa's estimate and refreshes every few minutes; clusters can vanish because positions closed or added margin, not only because they were liquidated. The used-up notice only fires when price also traded into the cluster.
- Mark/oracle checks use Hyperliquid's mark; the venue may liquidate on its own mark.
- `config.js` LEVELS and EVENTS are static and go stale.

## Backlog raised during the 22 Oct 2026 session

- Edit LEVELS and EVENTS from the page instead of `config.js`.
- Draw the liquidation buckets as a side histogram on the price chart.
- A short history of map snapshots so cluster changes over the last hour can be seen, not just the last step.
- Optional server-side watcher with push notifications when no browser is open.
