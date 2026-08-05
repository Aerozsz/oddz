import { parseFeed } from "../../feeds/rss";
import { fetchText } from "../../feeds/net";
import type { FetchGeoOptions, GeoSource, RawGeoItem } from "../types";

/**
 * Google News RSS, queried narrowly around Trump + each live theater and both
 * sides of the axis. Trump's Truth Social posts get reported by the wires
 * within minutes, so this catches the market-moving version of a post (the one
 * with a headline) almost as fast as the post itself — with no account needed.
 */
const QUERIES: string[] = [
  // Peace / de-escalation
  "Trump ceasefire",
  "Trump peace deal",
  "Trump peace talks",
  // Escalation
  "Trump strike",
  "Trump military",
  "Trump ultimatum",
  // Theaters (side falls out of the headline)
  "Trump Putin Ukraine",
  "Trump Iran Israel",
  "Trump China Taiwan",
  "Trump North Korea",
  // Trade war
  "Trump tariffs",
  "Trump trade deal",
];

const FEED = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=en-US&gl=US&ceid=US:en`;

export class GoogleNewsGeoSource implements GeoSource {
  readonly slug = "google-news";
  readonly label = "Google News";

  async fetch(opts: FetchGeoOptions = {}): Promise<RawGeoItem[]> {
    const byId = new Map<string, RawGeoItem>();
    const results = await Promise.allSettled(
      QUERIES.map((q) => fetchText(FEED(q), { signal: opts.signal })),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of parseFeed(r.value)) {
        if (opts.since && item.publishedAt && item.publishedAt < opts.since) continue;
        const externalId = item.guid ?? item.link;
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
