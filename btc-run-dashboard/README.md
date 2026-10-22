# BTC Triple Run

Live monitor for a tracked BTC paper position on Hyperliquid prices, with Coinversa liquidation data. Static page in `public/`, two Vercel functions in `api/`.

- Read `HANDOVER.md` for how it works, the data sources, env vars and the rules.
- `npm install && npm test` runs the engine, API and page tests.
- Deploy with `npx vercel deploy --prod`.
