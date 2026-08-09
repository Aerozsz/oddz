/**
 * Every place a headline or a crowd reaction can be collected from, and an
 * honest account of which ones are actually reachable.
 *
 * The first version polled three crypto news outlets over RSS. That was wrong
 * in a way worth keeping written down: those outlets *report* moves. By the time
 * a story is on the wire the cascade it describes is over, the book has
 * re-formed, and an agent reacting to it is trading the aftermath. A structurally
 * late feed is not a fast feed with a delay, it is a record of history.
 *
 * So the sources here are ordered by how early they can possibly be:
 *
 *  1. **The tape** (see shock.ts) — milliseconds. Every event reaches the order
 *     book before it reaches any wire, because the book is how it reaches the
 *     world. This is the primary detector and needs no network at all.
 *  2. **Exchange announcements** — seconds to minutes, and the genuine first
 *     source for listings, delistings and halts, which move price hard and are
 *     published by the venue before anyone writes about them.
 *  3. **Forums and social** — minutes. Useful as *velocity*, not as text: a
 *     sudden spike in how often a ticker is mentioned is measurable and fast,
 *     while reading the posts is neither.
 *  4. **News wires** — tens of minutes. Demoted to labelling a move after the
 *     fact so a human reading a post-mortem can see what it was.
 *
 * ## What cannot be collected, stated plainly
 *
 * **Twitter/X** has no free API. The v2 tiers that allow search start around
 * $100/month, the open Nitter mirrors are effectively dead, and scraping the
 * site is both against its terms and reliably blocked within hours. It is
 * supported here *only* if a bearer token is supplied — and when one is not,
 * the source reports itself unavailable rather than failing quietly, because a
 * dead source that looks alive is worse than an absent one.
 *
 * **LinkedIn** has no public content API and direct scraping risks the account
 * rather than merely failing.
 *
 * Both are reachable anyway, through a self-hosted RSSHub — an open-source
 * bridge that turns X timelines, X keyword searches, LinkedIn company pages,
 * Telegram channels and Discord into ordinary RSS. That moves the fetching, the
 * rate limits and the terms question onto infrastructure the operator runs,
 * which is where they belong; the agent then reads plain RSS from localhost and
 * knows nothing about the origin. One container:
 *
 *     docker run -d -p 1200:1200 diygod/rsshub
 *     SWEEP_RSSHUB=http://localhost:1200
 *     SWEEP_RSSHUB_ROUTES=/twitter/keyword/bitcoin,/linkedin/company/binance
 *
 * Every source that needs a credential reports itself unavailable when it is
 * missing, rather than returning nothing quietly. A dead source that looks alive
 * is indistinguishable from a quiet market, which is the most expensive way for
 * a feed to fail.
 */

export type SourceKind = "announcement" | "forum" | "social" | "wire";

export interface SourceDef {
  id: string;
  label: string;
  kind: SourceKind;
  /** How often to poll, in seconds. */
  everySec: number;
  /** Absent when the source needs a credential that is not set. */
  build: () => { url: string; headers?: Record<string, string> } | null;
  /** Pull headlines out of whatever shape this source returns. */
  parse: (body: string) => RawItem[];
  /** Why it is unavailable, when it is. */
  unavailable?: string;
}

export interface RawItem {
  headline: string;
  url: string | null;
  at: number;
  /** Engagement, where the source exposes it. Drives velocity, not impact. */
  score?: number;
}

const UA = "sweep-agent/1.0 (market research; contact via repo)";
const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/* --------------------------------------------------------- announcements */

/**
 * Binance's own announcement feed.
 *
 * The highest-value network source by a wide margin. A listing or a delisting
 * is published here before any outlet covers it, and both move the affected
 * contract violently — which is exactly the regime where this strategy's
 * assumptions stop holding and it should be standing back.
 */
const binanceAnnouncements: SourceDef = {
  id: "binance-announce",
  label: "Binance announcements",
  kind: "announcement",
  everySec: 60,
  build: () => ({
    url: "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20",
    headers: { "user-agent": UA, accept: "application/json" },
  }),
  parse: (body) => {
    const d = json(body) as { data?: { catalogs?: { articles?: { title?: string; code?: string; releaseDate?: number }[] }[] } } | null;
    const out: RawItem[] = [];
    for (const cat of d?.data?.catalogs ?? []) {
      for (const a of cat.articles ?? []) {
        if (!a.title) continue;
        out.push({
          headline: a.title,
          url: a.code ? `https://www.binance.com/en/support/announcement/${a.code}` : null,
          at: a.releaseDate ?? Date.now(),
        });
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------- forums */

/** Reddit's public JSON. No key; a real user-agent is required or it 429s. */
const reddit = (sub: string, everySec = 120): SourceDef => ({
  id: `reddit-${sub}`,
  label: `r/${sub}`,
  kind: "forum",
  everySec,
  build: () => ({
    url: `https://www.reddit.com/r/${sub}/new.json?limit=50`,
    headers: { "user-agent": UA },
  }),
  parse: (body) => {
    const d = json(body) as { data?: { children?: { data?: { title?: string; permalink?: string; created_utc?: number; score?: number } }[] } } | null;
    return (d?.data?.children ?? [])
      .map((c) => c.data)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.title))
      .map((p) => ({
        headline: p.title!,
        url: p.permalink ? `https://reddit.com${p.permalink}` : null,
        at: p.created_utc ? p.created_utc * 1000 : Date.now(),
        score: p.score ?? 0,
      }));
  },
});

/**
 * 4chan /biz/, through the documented read-only JSON API.
 *
 * Included without irony. It is early, it is unfiltered, and it is used here
 * only as mention velocity — the count of times a ticker appears, never the
 * content of any post. As a sentiment thermometer during a retail-driven move
 * it is genuinely faster than the wires, and as a source of facts it is worth
 * nothing, which is why nothing here reads it as one.
 */
const fourchanBiz: SourceDef = {
  id: "4chan-biz",
  label: "4chan /biz/",
  kind: "forum",
  everySec: 180,
  build: () => ({ url: "https://a.4cdn.org/biz/catalog.json", headers: { "user-agent": UA } }),
  parse: (body) => {
    const pages = json(body) as { threads?: { sub?: string; com?: string; time?: number; replies?: number }[] }[] | null;
    const out: RawItem[] = [];
    for (const page of pages ?? []) {
      for (const th of page.threads ?? []) {
        const text = `${th.sub ?? ""} ${th.com ?? ""}`.replace(/<[^>]+>/g, " ").replace(/&#\d+;/g, " ").trim();
        if (!text) continue;
        out.push({ headline: text.slice(0, 200), url: null, at: (th.time ?? 0) * 1000 || Date.now(), score: th.replies ?? 0 });
      }
    }
    return out;
  },
};

/** Hacker News via Algolia. No key. Catches infrastructure and macro stories. */
const hackerNews: SourceDef = {
  id: "hn",
  label: "Hacker News",
  kind: "forum",
  everySec: 300,
  build: () => ({
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&query=crypto%20OR%20bitcoin%20OR%20binance&hitsPerPage=30",
    headers: { "user-agent": UA },
  }),
  parse: (body) => {
    const d = json(body) as { hits?: { title?: string; url?: string; created_at_i?: number; points?: number }[] } | null;
    return (d?.hits ?? [])
      .filter((h) => h.title)
      .map((h) => ({
        headline: h.title!,
        url: h.url ?? null,
        at: (h.created_at_i ?? 0) * 1000 || Date.now(),
        score: h.points ?? 0,
      }));
  },
};

/* ---------------------------------------------------------------- social */

/**
 * X/Twitter, only with a bearer token.
 *
 * Reports itself unavailable when SWEEP_X_BEARER is unset rather than silently
 * returning nothing, because a source that looks configured and yields no items
 * is indistinguishable from a quiet market — and that is the single most
 * expensive way for a feed to fail.
 */
const twitter = (): SourceDef => ({
  id: "x",
  label: "X / Twitter",
  kind: "social",
  everySec: 120,
  unavailable: process.env.SWEEP_X_BEARER
    ? undefined
    : "no SWEEP_X_BEARER set — X has no free tier, and scraping it is both against its terms and blocked within hours",
  build: () => {
    const bearer = process.env.SWEEP_X_BEARER;
    if (!bearer) return null;
    const q = encodeURIComponent("(bitcoin OR binance OR $BTC) -is:retweet lang:en");
    return {
      url: `https://api.twitter.com/2/tweets/search/recent?query=${q}&max_results=50&tweet.fields=created_at,public_metrics`,
      headers: { authorization: `Bearer ${bearer}`, "user-agent": UA },
    };
  },
  parse: (body) => {
    const d = json(body) as { data?: { text?: string; created_at?: string; public_metrics?: { like_count?: number } }[] } | null;
    return (d?.data ?? [])
      .filter((t) => t.text)
      .map((t) => ({
        headline: t.text!.slice(0, 200),
        url: null,
        at: t.created_at ? Date.parse(t.created_at) : Date.now(),
        score: t.public_metrics?.like_count ?? 0,
      }));
  },
});

/**
 * Anything, through a self-hosted RSSHub.
 *
 * This is the answer to "find a way" for X, and it is a legitimate one rather
 * than a scraper. RSSHub is open source, runs in one container, and exposes
 * hundreds of sites — including X timelines and searches, LinkedIn company
 * pages, Telegram channels and Discord — as ordinary RSS. Pointing this at a
 * local instance moves the fetching, the rate limits and the terms-of-service
 * question onto infrastructure the operator controls, which is where they
 * belong: the agent then reads plain RSS from localhost and knows nothing about
 * where it came from.
 *
 *     docker run -d -p 1200:1200 diygod/rsshub
 *     SWEEP_RSSHUB=http://localhost:1200
 *     SWEEP_RSSHUB_ROUTES=/twitter/user/elonmusk,/twitter/keyword/bitcoin
 *
 * Absent the variable it reports itself unconfigured rather than silently
 * yielding nothing, for the same reason X does.
 */
function rsshubRoutes(): SourceDef[] {
  /*
   * A public instance by default, so this needs no setup at all.
   *
   * Self-hosting is better — faster, unshared, unthrottled — but requiring it
   * meant X and LinkedIn were off for anyone who did not stop to run a
   * container, which in practice means off. The public instance is rate limited
   * and occasionally down; both are handled by the poller's per-source error
   * tracking, and a degraded social feed is worth more than an absent one.
   *
   * Point SWEEP_RSSHUB at localhost to take it off the shared instance.
   */
  const base = (process.env.SWEEP_RSSHUB?.trim() || "https://rsshub.app").replace(/\/$/, "");
  const routes = (process.env.SWEEP_RSSHUB_ROUTES ?? "")
    .split(",").map((r) => r.trim()).filter(Boolean);
  const list = routes.length
    ? routes
    : [
        "/twitter/keyword/bitcoin",
        "/twitter/keyword/binance",
        "/twitter/keyword/liquidation",
      ];
  // A shared instance is slower and rate limited, so poll it less often than a
  // local one would be.
  const cadence = base.includes("rsshub.app") ? 300 : 120;
  return list.map((route) => ({
    id: `rsshub${route.replace(/[^a-z0-9]+/gi, "-")}`,
    label: `RSSHub ${route}`,
    kind: "social" as const,
    everySec: cadence,
    build: () => ({ url: `${base}${route}`, headers: { "user-agent": UA } }),
    parse: rssParse,
  }));
}

/** Recorded so the answer is not rediscovered every few months. */
const linkedin: SourceDef = {
  id: "linkedin",
  label: "LinkedIn",
  kind: "social",
  everySec: 3600,
  unavailable:
    "no public content API, and direct scraping risks the account rather than merely failing. Reachable " +
    "through the RSSHub bridge above (/linkedin/company/<name>), which is the only route worth taking.",
  build: () => null,
  parse: () => [],
};

/* ----------------------------------------------------------------- wires */

function rssParse(body: string): RawItem[] {
    const out: RawItem[] = [];
    for (const m of body.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
      const block = m[1];
      const field = (tag: string) => {
        const f = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
        return f
          ? f[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
          : null;
      };
      const headline = field("title");
      if (!headline) continue;
      const d = field("pubDate") ?? field("dc:date");
      const at = d ? Date.parse(d) : NaN;
      out.push({ headline, url: field("link"), at: Number.isFinite(at) ? at : Date.now() });
    }
  return out;
}

const rss = (id: string, label: string, url: string): SourceDef => ({
  id, label, kind: "wire", everySec: 300,
  build: () => ({ url, headers: { "user-agent": UA } }),
  parse: rssParse,
});

/*
 * Built on first use, not at import.
 *
 * Two of these read the environment to decide whether they exist at all — the X
 * bearer and the RSSHub base — and a worker calls loadEnv() in its body, which
 * runs *after* every import in the file has already been evaluated. Building the
 * list eagerly therefore read the environment before .env had been applied, so a
 * perfectly good SWEEP_X_BEARER produced a source that reported itself
 * unconfigured. The failure is silent and looks exactly like a quiet feed, which
 * is the failure mode this file's header spends a paragraph warning about.
 */
let cache: SourceDef[] | null = null;

export function sources(): SourceDef[] {
  if (cache) return cache;
  cache = [
    binanceAnnouncements,
    reddit("CryptoCurrency"),
    reddit("Bitcoin"),
    reddit("binance", 300),
    reddit("CryptoMarkets", 300),
    reddit("wallstreetbets", 300),
    fourchanBiz,
    hackerNews,
    twitter(),
    ...rsshubRoutes(),
    linkedin,
    rss("coindesk", "CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    rss("cointelegraph", "Cointelegraph", "https://cointelegraph.com/rss"),
    rss("theblock", "The Block", "https://www.theblock.co/rss.xml"),
  ];
  return cache;
}

export const available = () => sources().filter((s) => !s.unavailable && s.build() !== null);
export const unavailable = () => sources().filter((s) => s.unavailable || s.build() === null);
