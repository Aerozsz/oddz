/**
 * The news store. Small surface, but two failure modes that matter: the same
 * story arriving twice from two outlets during a fast market, and an
 * unattributable headline being promoted to the top of the feed.
 */
import { recordNews, readNews, newsFor } from "@/lib/sweep/metrics/news-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const dir = mkdtempSync(join(tmpdir(), "news-"));
const P = join(dir, "news.json");

console.log("\n## recording");
{
  const r = recordNews({ headline: "Intel guides Q4 revenue above consensus", sourceUrl: "https://example.com/a", symbols: ["INTCUSDT"], impact: "high" }, P);
  ok("it records", r.ok && r.item !== null);
  ok("...keeping the source", r.item?.sourceUrl === "https://example.com/a");
  ok("...and the symbol, upper-cased", r.item?.symbols[0] === "INTCUSDT");
  ok("...at the impact given, since it is sourced", r.item?.impact === "high", r.item?.impact);
  ok("an empty headline is refused", !recordNews({ headline: "   " }, P).ok);
}

console.log("\n## an unsourced item cannot be high impact");
{
  const r = recordNews({ headline: "Rumour of a fab delay", impact: "high" }, P);
  ok("it is still recorded", r.ok);
  ok("...but downgraded", r.item?.impact === "medium", r.item?.impact);
  ok("...and says so", (r.note ?? "").includes("downgraded"), r.note ?? "");
  ok("...and is marked unsourced", r.item?.sourceUrl === null);
}

console.log("\n## the same story twice");
{
  const before = readNews(P).length;
  const dup = recordNews({ headline: "INTEL GUIDES Q4 REVENUE ABOVE CONSENSUS!", sourceUrl: "https://other.com/b" }, P);
  ok("a restated headline is caught", !dup.ok, dup.note ?? "");
  ok("...and nothing is added", readNews(P).length === before, `${readNews(P).length} vs ${before}`);
  ok("...returning the one already held", dup.item?.sourceUrl === "https://example.com/a");
}

console.log("\n## the feed for a contract");
{
  recordNews({ headline: "Fed holds rates", sourceUrl: "https://example.com/macro" }, P);
  recordNews({ headline: "SanDisk cuts NAND output", sourceUrl: "https://example.com/s", symbols: ["SNDKUSDT"] }, P);

  const intc = newsFor("INTCUSDT", 25, P).map((x) => x.headline);
  ok("it includes the symbol's own news", intc.some((h) => h.includes("Intel guides")));
  ok("...and market-wide items", intc.some((h) => h.includes("Fed holds")));
  ok("...but not another symbol's", !intc.some((h) => h.includes("SanDisk")), intc.join(" | "));

  const sndk = newsFor("SNDKUSDT", 25, P).map((x) => x.headline);
  ok("the other contract sees its own", sndk.some((h) => h.includes("SanDisk")));
  ok("...and the macro item too", sndk.some((h) => h.includes("Fed holds")));

  ok("lower case works the same", newsFor("intcusdt", 25, P).length === intc.length);
  ok("the limit is honoured", newsFor("INTCUSDT", 1, P).length === 1);
}

console.log("\n## ordering and resilience");
{
  const now = Date.now();
  recordNews({ headline: "Older item", at: new Date(now - 3 * 3600_000).toISOString(), sourceUrl: "https://x/1" }, P);
  recordNews({ headline: "Newest item", at: new Date(now + 1000).toISOString(), sourceUrl: "https://x/2" }, P);
  const feed = newsFor("INTCUSDT", 25, P);
  ok("newest first", feed[0].headline === "Newest item", feed[0].headline);
  ok("...with the old one still present but lower", feed.some((x) => x.headline === "Older item"));

  ok("a missing file reads as empty", readNews(join(dir, "nope.json")).length === 0);
  const bad = join(dir, "bad.json");
  require("node:fs").writeFileSync(bad, "{not json");
  ok("a corrupt file reads as empty rather than throwing", readNews(bad).length === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
