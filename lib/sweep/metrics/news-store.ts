import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * What is being said about the instrument, as opposed to what is happening to
 * its order book.
 *
 * Everything else in this project is derived from market data: the book, the
 * tape, the funding, the liquidations. That is deliberate — those are facts
 * with timestamps, and the models built on them can be checked. News is not
 * that. It arrives in prose, it is often wrong, and it is nearly always already
 * in the price by the time it is readable.
 *
 * So this store exists for one narrow purpose, and it is worth being explicit
 * about the boundary. Nothing here feeds the sizer, the bias, or any signal.
 * It answers a question the operator has and the machine cannot: *why* is the
 * book behaving like this. A depth withdrawal that coincides with a headline is
 * a different situation from an identical withdrawal with nothing behind it —
 * not because the metric differs, but because one of them will mean-revert and
 * the other will not, and no amount of order-book data distinguishes them.
 *
 * Written by an agent through the MCP interface (see workers/sweep-mcp.ts),
 * which is where the collection actually happens — this file only keeps what
 * was found and hands it to the page. Append-only with a bounded tail, for the
 * same reason the event calendar is: an agent that can delete its own record of
 * what it reported can quietly rewrite history, and a log that can be rewritten
 * is not evidence of anything.
 */

export type NewsImpact = "high" | "medium" | "low";

export interface NewsItem {
  id: string;
  /** When the news is about, not when it was recorded. */
  at: number;
  recordedAt: number;
  headline: string;
  /** One or two sentences. Anything longer belongs behind the link. */
  summary: string | null;
  /**
   * Where it came from. Unsourced items are kept but marked, because an
   * unattributable headline is a rumour and should read as one.
   */
  sourceUrl: string | null;
  source: string | null;
  /** Contracts this bears on. Empty means it is macro or market-wide. */
  symbols: string[];
  impact: NewsImpact;
  /** Which way it reads, when it reads either way at all. */
  direction: "up" | "down" | null;
  recordedBy: string;
}

const MAX_ITEMS = 300;
/** Anything older than this is not news any more. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function newsPath(): string {
  return resolve(process.env.SWEEP_NEWS ?? "data/sweep-news.json");
}

export function readNews(path = newsPath()): NewsItem[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is NewsItem => Boolean(x && typeof x.headline === "string"));
  } catch {
    // A corrupt file must not take the page down. News is decoration on top of
    // the market data, and losing it costs nothing that matters.
    return [];
  }
}

function writeNews(items: NewsItem[], path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface RecordNewsInput {
  headline: string;
  at?: string | number;
  summary?: string | null;
  sourceUrl?: string | null;
  source?: string | null;
  symbols?: string[];
  impact?: NewsImpact;
  direction?: "up" | "down" | null;
  recordedBy?: string;
}

export interface RecordNewsResult {
  ok: boolean;
  item: NewsItem | null;
  /** Set when an item was rejected or altered on the way in. */
  note: string | null;
  total: number;
}

/**
 * Add an item, or say why not.
 *
 * Deduplicated on the headline rather than on an id the caller supplies,
 * because the realistic failure is an agent re-reporting the same story from a
 * second outlet on its next pass — and a feed that shows one event five times
 * is worse than useless during exactly the fast market where it is being read.
 */
export function recordNews(input: RecordNewsInput, path = newsPath()): RecordNewsResult {
  const headline = String(input.headline ?? "").trim();
  if (!headline) return { ok: false, item: null, note: "a headline is required", total: 0 };

  const items = readNews(path);
  const now = Date.now();

  const at = (() => {
    if (typeof input.at === "number" && Number.isFinite(input.at)) return input.at;
    if (typeof input.at === "string") {
      const parsed = Date.parse(input.at);
      if (Number.isFinite(parsed)) return parsed;
    }
    return now;
  })();

  const key = headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const duplicate = items.find(
    (x) => x.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key,
  );
  if (duplicate) {
    return { ok: false, item: duplicate, note: "already recorded", total: items.length };
  }

  const sourceUrl = typeof input.sourceUrl === "string" && input.sourceUrl.trim() ? input.sourceUrl.trim() : null;
  const item: NewsItem = {
    id: `${at}-${key.slice(0, 40).replace(/\s+/g, "-")}`,
    at,
    recordedAt: now,
    headline,
    summary: typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : null,
    sourceUrl,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : null,
    symbols: Array.isArray(input.symbols)
      ? [...new Set(input.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))]
      : [],
    /*
     * An unsourced item cannot be high impact.
     *
     * The pressure on anything writing into this store is to overstate: a
     * headline marked high sits at the top of the feed and gets read during a
     * move. Requiring a link before that is possible is the cheapest available
     * check on it, and it costs nothing when the source is real.
     */
    impact: sourceUrl ? (input.impact ?? "medium") : input.impact === "high" ? "medium" : (input.impact ?? "low"),
    direction: input.direction === "up" || input.direction === "down" ? input.direction : null,
    recordedBy: typeof input.recordedBy === "string" ? input.recordedBy : "unknown",
  };

  const kept = [item, ...items]
    .filter((x) => now - x.at < MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ITEMS);
  writeNews(kept, path);

  return {
    ok: true,
    item,
    note: !sourceUrl && input.impact === "high" ? "downgraded to medium — an unsourced item cannot be high impact" : null,
    total: kept.length,
  };
}

/**
 * The feed for a contract: anything naming it, plus anything market-wide.
 *
 * Market-wide items are included rather than filtered out because they are the
 * ones that explain a book going thin on every symbol at once, which is exactly
 * the case where a per-symbol feed would show nothing and leave the operator
 * assuming the metric is broken.
 */
export function newsFor(symbol: string, limit = 25, path = newsPath()): NewsItem[] {
  const want = symbol.trim().toUpperCase();
  return readNews(path)
    .filter((x) => x.symbols.length === 0 || x.symbols.includes(want))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/**
 * The store reduced to the four numbers a live decision can use.
 *
 * Kept here rather than in the agent so there is one definition of "what the
 * news says right now", shared by the sizer, the post-mortem and the page. Two
 * that disagreed would be worse than either.
 */
export function newsPressure(symbol: string, now = Date.now(), path = newsPath()) {
  const SIX_HOURS = 6 * 3_600_000;
  const items = newsFor(symbol, 50, path).filter((n) => n.at <= now && now - n.at <= SIX_HOURS);
  const weight = (i: string) => (i === "high" ? 3 : i === "medium" ? 2 : i === "low" ? 1 : 0);
  const newest = items.reduce<typeof items[number] | null>((a, n) => (!a || n.at > a.at ? n : a), null);
  return {
    impact: items.reduce((a, n) => Math.max(a, weight(n.impact)), 0),
    minutesSince: newest ? (now - newest.at) / 60_000 : null,
    count6h: items.length,
    latest: newest?.headline ?? null,
  };
}
