/**
 * A tiny, dependency-free RSS 2.0 / Atom parser. The rest of the codebase
 * talks JSON (zod-validated via `fetchJson`), but the fastest, key-free news
 * sources — Google News, Intel's newsroom — only publish XML feeds, and
 * pulling in a full XML dependency for a handful of fields isn't worth it.
 *
 * This is intentionally forgiving: feeds vary, and a monitor that throws on a
 * slightly-off feed is a monitor that misses the news it exists to catch.
 */

export interface FeedItem {
  title: string;
  link: string;
  guid?: string;
  summary?: string;
  publishedAt?: Date;
}

/** Grab the inner text of the first <tag>…</tag>, CDATA-aware. */
function tag(block: string, name: string): string | undefined {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  if (!m) return undefined;
  return decode(stripCdata(m[1])).trim() || undefined;
}

/** Atom links are attributes: <link href="…" rel="alternate"/>. */
function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)];
  if (links.length === 0) return undefined;
  // Prefer rel="alternate" (the human page) over rel="self"/enclosure.
  const alt = links.find((l) => /rel=["']?alternate/i.test(l[1])) ?? links[0];
  const href = alt[1].match(/href=["']([^"']+)["']/i);
  return href ? decode(href[1]).trim() : undefined;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Strip any HTML tags left inside a summary/description blob. */
function plain(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  // RSS <item> and Atom <entry> are handled the same way.
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ];

  for (const [block] of blocks) {
    const title = tag(block, "title");
    const link = tag(block, "link") ?? atomLink(block);
    if (!title || !link) continue;

    const publishedAt =
      parseDate(tag(block, "pubDate")) ??
      parseDate(tag(block, "published")) ??
      parseDate(tag(block, "updated")) ??
      parseDate(tag(block, "dc:date"));

    items.push({
      title,
      link,
      guid: tag(block, "guid") ?? tag(block, "id"),
      summary: plain(tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content")),
      publishedAt,
    });
  }

  return items;
}
