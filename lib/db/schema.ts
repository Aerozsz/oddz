import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const venues = pgTable("venues", {
  slug: text().primaryKey(),
  name: text().notNull(),
  homepage: text().notNull(),
  affiliateUrlTemplate: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: text().primaryKey(),
    canonicalKey: text().notNull(),
    title: text().notNull(),
    category: text(),
    endsAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_canonical_key_idx").on(t.canonicalKey),
    index("events_ends_at_idx").on(t.endsAt),
  ],
);

export const markets = pgTable(
  "markets",
  {
    id: text().primaryKey(),
    venueSlug: text()
      .notNull()
      .references(() => venues.slug),
    eventId: text().references(() => events.id, { onDelete: "set null" }),
    externalId: text().notNull(),
    slug: text().notNull(),
    question: text().notNull(),
    description: text(),
    category: text(),
    outcomes: jsonb().$type<string[]>().notNull(),
    sourceUrl: text().notNull(),
    endsAt: timestamp({ withTimezone: true }),
    closed: integer().notNull().default(0),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("markets_venue_external_idx").on(t.venueSlug, t.externalId),
    index("markets_event_idx").on(t.eventId),
    index("markets_last_seen_idx").on(t.lastSeenAt),
    index("markets_closed_idx").on(t.closed),
  ],
);

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    marketId: text()
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    takenAt: timestamp({ withTimezone: true }).notNull(),
    prices: jsonb().$type<number[]>().notNull(),
    volume: doublePrecision(),
    liquidity: doublePrecision(),
    openInterest: doublePrecision(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.takenAt] }),
    index("snapshots_taken_at_idx").on(t.takenAt),
  ],
);

export const snapshotRuns = pgTable("snapshot_runs", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
  status: text().notNull().default("running"),
  stats: jsonb()
    .$type<Record<string, { fetched: number; written: number; truncated?: boolean; error?: string }>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

export const apiKeys = pgTable("api_keys", {
  // SHA-256 hex of the raw key; the raw key is shown once at creation.
  keyHash: text().primaryKey(),
  name: text().notNull(),
  tier: text().notNull().default("free"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp({ withTimezone: true }),
});

export const apiUsage = pgTable(
  "api_usage",
  {
    // API key hash, or "ip:<addr>" for anonymous callers.
    identifier: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.windowStart] })],
);

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    // Anonymous device id from the `wid` cookie — no accounts in v1
    // (docs/watchlists-design.md).
    watcherId: text().notNull(),
    marketId: text()
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.watcherId, t.marketId] })],
);

export const alertRules = pgTable(
  "alert_rules",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // Same anonymous device id as the watchlist (`wid` cookie).
    watcherId: text().notNull(),
    marketId: text()
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    /** price_above / price_below: threshold is a YES probability (0..1).
     *  move_24h: threshold is an absolute 24h change in probability (0..1). */
    kind: text().$type<"price_above" | "price_below" | "move_24h">().notNull(),
    threshold: doublePrecision().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // One-shot: set when the condition first holds; cleared by re-arming.
    triggeredAt: timestamp({ withTimezone: true }),
    triggeredValue: doublePrecision(),
  },
  (t) => [
    index("alert_rules_watcher_idx").on(t.watcherId),
    index("alert_rules_market_idx").on(t.marketId),
  ],
);

export const subscribers = pgTable("subscribers", {
  email: text().primaryKey(),
  source: text().notNull().default("landing"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * INTC foundry-catalyst feed. One row per deduped news item / SEC filing the
 * monitor has seen; `notifiedAt` marks the ones that cleared the severity
 * threshold and were pushed. `id` is a deterministic hash of source+url so
 * the same story from a re-poll conflicts instead of duplicating.
 */
export const intcNews = pgTable(
  "intc_news",
  {
    id: text().primaryKey(),
    sourceSlug: text().notNull(),
    sourceLabel: text().notNull(),
    title: text().notNull(),
    url: text().notNull(),
    summary: text(),
    /** low | medium | high | critical */
    severity: text().$type<"low" | "medium" | "high" | "critical">().notNull(),
    /** bullish | bearish | neutral — the lean for the equity. */
    direction: text().$type<"bullish" | "bearish" | "neutral">().notNull(),
    score: integer().notNull().default(0),
    /** Matched signal-group labels, for display and audit. */
    tags: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    publishedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("intc_news_first_seen_idx").on(t.firstSeenAt),
    index("intc_news_severity_idx").on(t.severity),
    index("intc_news_notified_idx").on(t.notifiedAt),
  ],
);

/** Heartbeat + audit for each monitor run, so /intc can show it's alive. */
export const intcMonitorRuns = pgTable("intc_monitor_runs", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
  status: text().notNull().default("running"),
  fetched: integer().notNull().default(0),
  relevant: integer().notNull().default(0),
  inserted: integer().notNull().default(0),
  notified: integer().notNull().default(0),
  stats: jsonb()
    .$type<Record<string, { fetched: number; error?: string }>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

export type IntcNews = typeof intcNews.$inferSelect;
export type NewIntcNews = typeof intcNews.$inferInsert;

export type Venue = typeof venues.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type NewPriceSnapshot = typeof priceSnapshots.$inferInsert;
