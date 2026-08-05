import { parseFeed } from "../rss";
import { fetchText } from "../net";
import type { FetchNewsOptions, NewsSource, RawNewsItem } from "../types";

/**
 * Intel's own newsroom RSS. First-party announcements — a foundry customer,
 * a node milestone, an executive statement — land here at the source, without
 * a reporter's turnaround. Lower recall than Google News (Intel only posts its
 * own PR) but the highest signal when it does fire.
 */
const FEEDS = [
  "https://newsroom.intel.com/feed",
  "https://www.intc.com/rss/news-releases.xml", // investor-relations releases
];

export class IntelNewsroomSource implements NewsSource {
  readonly slug = "intel-newsroom";
  readonly label = "Intel Newsroom";
  readonly assumeEntity = true;

  async fetch(opts: FetchNewsOptions = {}): Promise<RawNewsItem[]> {
    const byId = new Map<string, RawNewsItem>();
    const results = await Promise.allSettled(
      FEEDS.map((f) => fetchText(f, { signal: opts.signal })),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of parseFeed(r.value)) {
        if (opts.since && item.publishedAt && item.publishedAt < opts.since) continue;
        const externalId = item.guid ?? item.link;
        if (!byId.has(externalId)) {
          byId.set(externalId, {
            externalId,
            title: item.title,
            url: item.link,
            summary: item.summary,
            publishedAt: item.publishedAt,
            sourceLabel: this.label,
            assumeEntity: true,
          });
        }
      }
    }

    return [...byId.values()];
  }
}
