# Watchlists — design doc

Status: approved-for-build (next autonomous cycle picks this up)

## Goal

Let a trader pin markets/events and see them on one page with current
price, 24h delta, and sparkline. This is the retention feature — the
page a user opens every morning — and the natural hook for the paid
Trader tier (alerts on watched markets).

## Decision: no accounts in v1

Full auth (NextAuth/Clerk) is heavy and gates a feature that needs zero
personal data. v1 uses an **anonymous device identity**:

- First visit sets a `wid` cookie: `crypto.randomUUID()`, httpOnly,
  SameSite=Lax, 1-year expiry.
- Watchlist rows key off that id. No email, no password, no PII.
- When real auth ships later (Trader tier), the `wid` list merges into
  the account on first login — table already has the column shape for it.

Tradeoff accepted: lists don't roam across devices in v1. Fine — the
digest email (already captured on landing) is the cross-device surface.

## Schema (migration 0002)

```ts
export const watchlistItems = pgTable(
  "watchlist_items",
  {
    watcherId: text().notNull(),          // wid cookie value
    marketId: text().notNull().references(() => markets.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.watcherId, t.marketId] })],
);
```

Cap: 100 items per watcher (enforced in the action, not the DB).

## Surfaces

1. **Star toggle** — small client component on market rows and the
   market detail header. Server action `toggleWatch(marketId)`:
   reads/sets the `wid` cookie, upserts/deletes, revalidates `/watchlist`.
2. **/watchlist page** — server component; reuses `listMarkets`-style
   join for current price + `getSparklines`; adds 24h delta via the
   movers CTE pattern with a `market_id IN (...)` filter. Empty state
   sells the feature ("Star any market to track it here").
3. **Nav** — "Watchlist" link with count badge (server-read cookie).

## Non-goals for v1

- Alerts on watched markets (needs email/Telegram infra — Trader tier)
- Ordering/folders
- Sharing lists

## Test plan

- Star from /markets row → row appears on /watchlist
- Unstar from /watchlist → disappears
- Cookie absent → /watchlist shows empty state, starring creates cookie
- 101st star → friendly error
