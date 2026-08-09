/**
 * Pull headlines on a timer and put them where the agent can read them.
 *
 *   npm run sweep:news
 *
 * The gap this closes was embarrassing. There was a news *store*, an MCP tool
 * to write to it, a panel to display it, and a field on every trade record to
 * carry it — and nothing that ever fetched anything. The store was empty unless
 * an agent happened to write to it by hand, so the panel showed nothing, the
 * covariate on every trade was an empty array, and a capability that looked
 * present in four places did not exist.
 *
 * Sources are public RSS and need no key. That is a deliberate constraint: a
 * feed that needs an API key is a feed that silently stops when the key expires,
 * and this one has to keep working unattended.
 *
 * What it does not do, stated plainly because the opposite is easy to assume:
 * it does not read the story, judge it, or decide anything. It records that a
 * headline of a given impact existed at a given time. Impact is inferred from
 * keywords, which is crude and admitted as crude — the agent uses it only to
 * step back from a market that is reacting to something, never to take a view
 * on what the something means.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { beat } from "./heartbeat";
import { loadEnv } from "./load-env";
import { recordNews, newsPath } from "../lib/sweep/metrics/news-store";

loadEnv();

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const EVERY_SEC = Math.max(60, Number(arg("every", "180")));

/**
 * Public RSS, no key, no account.
 *
 * Crypto-wide rather than per-symbol: what moves a perp on a weekend is a
 * market-wide event far more often than a story about one coin, and the store
 * treats an item with no symbols as applying to everything.
 */
const FEEDS: { url: string; source: string }[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://www.theblock.co/rss.xml", source: "The Block" },
];

/**
 * Impact from keywords, which is a blunt instrument used for a blunt purpose.
 *
 * This never decides direction — nothing here can tell whether an SEC filing is
 * good or bad for a price, and pretending otherwise is how a news feed becomes
 * a random number generator with a narrative. It only separates "something is
 * happening" from "ordinary coverage", so the sizer can stand back during the
 * first and ignore the second.
 */
const HIGH = /\b(hack|exploit|halt|suspend|bankrupt|liquidat|SEC|lawsuit|ban|seiz|collapse|emergency|flash crash|depeg|outage)\b/i;
const MEDIUM = /\b(ETF|approval|rate|inflation|CPI|FOMC|Fed|regulat|upgrade|fork|listing|delist|partnership|acquisition)\b/i;

function impactOf(text: string): "high" | "medium" | "low" {
  if (HIGH.test(text)) return "high";
  if (MEDIUM.test(text)) return "medium";
  return "low";
}

/** Symbols named in a headline, so a per-symbol query can find them. */
const TICKERS: [RegExp, string][] = [
  [/\bbitcoin\b|\bBTC\b/i, "BTCUSDT"],
  [/\bethereum\b|\bETH\b|\bether\b/i, "ETHUSDT"],
  [/\bsolana\b|\bSOL\b/i, "SOLUSDT"],
  [/\bbinance\b|\bBNB\b/i, "BNBUSDT"],
  [/\bripple\b|\bXRP\b/i, "XRPUSDT"],
];

/*
 * A regex parser rather than an XML dependency.
 *
 * The whole payload needed is title, link and date from each <item>, the feeds
 * are well-formed, and a malformed one costs a skipped cycle rather than a
 * crash. Adding a parser to the dependency tree of a trading process to read
 * three fields is a worse trade than this.
 */
const ITEM = /<item[\s>]([\s\S]*?)<\/item>/gi;
const field = (block: string, tag: string): string | null => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
};

interface Headline {
  headline: string;
  url: string | null;
  at: number;
  source: string;
}

async function pull(feed: { url: string; source: string }): Promise<Headline[]> {
  const res = await fetch(feed.url, {
    headers: { "user-agent": "sweep-agent/1.0 (+trading research)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const xml = await res.text();

  const out: Headline[] = [];
  for (const m of xml.matchAll(ITEM)) {
    const block = m[1];
    const headline = field(block, "title");
    if (!headline) continue;
    const dateRaw = field(block, "pubDate") ?? field(block, "dc:date");
    const at = dateRaw ? Date.parse(dateRaw) : NaN;
    out.push({
      headline,
      url: field(block, "link"),
      // An item with an unparseable date is dated now rather than dropped: the
      // alternative is silently losing the newest items from a feed whose date
      // format changed, which is the case where they matter most.
      at: Number.isFinite(at) ? at : Date.now(),
      source: feed.source,
    });
  }
  return out;
}

let recorded = 0;
let cycles = 0;
let lastError: string | null = null;

async function cycle() {
  cycles++;
  for (const feed of FEEDS) {
    try {
      const items = await pull(feed);
      const fresh = items.filter((i) => Date.now() - i.at < 6 * 3_600_000);
      for (const i of fresh) {
        const symbols = TICKERS.filter(([re]) => re.test(i.headline)).map(([, s]) => s);
        const r = recordNews({
          headline: i.headline,
          summary: null,
          sourceUrl: i.url,
          source: i.source,
          impact: impactOf(i.headline),
          at: i.at,
          symbols,
          recordedBy: "sweep:news",
        } as Parameters<typeof recordNews>[0]);
        // The store dedupes; only count what was genuinely new.
        if (r.ok && r.item) {
          recorded++;
          if (impactOf(i.headline) === "high") {
            console.error(`[news] HIGH  ${i.headline.slice(0, 110)}`);
          }
        }
      }
      lastError = null;
    } catch (err) {
      lastError = `${feed.source}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[news] ${lastError}`);
    }
  }
}

const stopBeat = beat("sweep-news", () => ({
  recorded,
  cycles,
  feeds: FEEDS.length,
  everySec: EVERY_SEC,
  lastError,
  out: newsPath(),
}));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopBeat();
    console.error(`[news] stopped — ${recorded} items recorded to ${newsPath()}`);
    process.exit(0);
  });
}

console.error("");
console.error(`[news] ${FEEDS.map((f) => f.source).join(", ")} every ${EVERY_SEC}s`);
console.error(`[news] writing to ${newsPath()}`);
console.error("[news] impact is inferred from keywords and never implies a direction");
console.error("");

for (;;) {
  await cycle();
  console.error(`[news] cycle ${cycles} — ${recorded} recorded so far`);
  await sleep(EVERY_SEC * 1000);
}
