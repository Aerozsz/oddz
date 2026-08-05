import { parseFeed } from "../../feeds/rss";
import { fetchText } from "../../feeds/net";
import type { FetchNewsOptions, NewsSource, RawNewsItem } from "../types";

/**
 * Google News RSS — the fastest key-free general-news source. Google indexes
 * wire stories (Reuters, Bloomberg, DCD, Tom's Hardware, SemiAnalysis, …)
 * within minutes of publication, which is as close to real-time as a
 * no-account source gets.
 *
 * We run several *narrow* queries rather than one broad "Intel" query, so the
 * feed is pre-filtered to the foundry beat and the classifier has less noise
 * to reject. Each query is a Google News search feed.
 */
const QUERIES: string[] = [
  '"Intel foundry"',
  "Intel 18A customer",
  "Intel 14A",
  "Intel foundry customer",
  '"Intel Foundry Services"',
  "Intel foundry external revenue",
  "Intel foundry loss",
  "Intel foundry spinoff OR separation",
];

const FEED = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=en-US&gl=US&ceid=US:en`;

export class GoogleNewsSource implements NewsSource {
  readonly slug = "google-news";
  readonly label = "Google News";

  async fetch(opts: FetchNewsOptions = {}): Promise<RawNewsItem[]> {
    const byId = new Map<string, RawNewsItem>();

    // Queries run concurrently; one slow/failed query must not sink the rest.
    const results = await Promise.allSettled(
      QUERIES.map((q) => fetchText(FEED(q), { signal: opts.signal })),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of parseFeed(r.value)) {
        if (opts.since && item.publishedAt && item.publishedAt < opts.since) continue;
        const externalId = item.guid ?? item.link;
        // Google News wraps outlets in a "— Source" suffix on the title.
        const title = item.title.replace(/\s+-\s+[^-]+$/, "").trim() || item.title;
        if (!byId.has(externalId)) {
          byId.set(externalId, {
            externalId,
            title,
            url: item.link,
            summary: item.summary,
            publishedAt: item.publishedAt,
            sourceLabel: this.label,
          });
        }
      }
    }

    return [...byId.values()];
  }
}
