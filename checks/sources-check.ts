process.env.SWEEP_NEWS = "/tmp/sweep-checks/news-parse.json";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { sources } from "../lib/sweep/metrics/sources";

const by = (id: string) => { const s = sources().find(x => x.id === id); if (!s) throw new Error("no source " + id); return s; };
let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) fails++;
};

async function main() {
const now = Date.now();

/* Binance announcements: the real bapi shape */
{
  const body = JSON.stringify({ data: { catalogs: [ { articles: [
    { title: "Binance Will Delist ABCUSDT Perpetual Contract", code: "abc123", releaseDate: now - 60_000 },
    { title: "Binance Futures Will Launch USDⓈ-M XYZUSDT Perpetual", code: "xyz789", releaseDate: now - 120_000 },
    { title: null },
  ] } ] } });
  const items = by("binance-announce").parse(body);
  check("binance parses 2 of 3 (null title dropped)", items.length === 2, `got ${items.length}`);
  check("binance builds article url", items[0].url === "https://www.binance.com/en/support/announcement/abc123", String(items[0].url));
}

/* Reddit listing JSON */
{
  const body = JSON.stringify({ data: { children: [
    { data: { title: "Bitcoin just broke 100k", permalink: "/r/x/1", created_utc: (now-30_000)/1000, score: 42 } },
    { data: { title: "SOL is mooning", permalink: "/r/x/2", created_utc: (now-40_000)/1000, score: 7 } },
    { data: {} },
  ] } });
  const items = by("reddit-Bitcoin").parse(body);
  check("reddit parses 2 of 3", items.length === 2, `got ${items.length}`);
  check("reddit absolute url", items[0].url === "https://reddit.com/r/x/1", String(items[0].url));
  check("reddit ms timestamps", Math.abs(items[0].at - (now-30_000)) < 1000);
}

/* 4chan catalog: array of pages, HTML in com, entities */
{
  const body = JSON.stringify([ { threads: [
    { sub: "BTC general", com: "check this <br>bitcoin is &#039;pumping&#039;", time: Math.floor((now-90_000)/1000), replies: 300 },
    { com: "", time: Math.floor(now/1000) },
  ] } ]);
  const items = by("4chan-biz").parse(body);
  check("4chan strips markup and keeps one", items.length === 1, `got ${items.length}`);
  check("4chan has no tags left", !/[<>]/.test(items[0].headline), items[0].headline);
}

/* HN Algolia */
{
  const body = JSON.stringify({ hits: [ { title: "Exchange outage hits traders", url: "https://x.example", created_at_i: Math.floor((now-45_000)/1000), points: 90 } ] });
  const items = by("hn").parse(body);
  check("hn parses", items.length === 1 && items[0].headline.startsWith("Exchange outage"));
}

/* RSS with CDATA, entities, pubDate */
{
  const body = `<rss><channel>
    <item><title><![CDATA[SEC sues major exchange & wins]]></title><link>https://a.example/1</link><pubDate>${new Date(now-100_000).toUTCString()}</pubDate></item>
    <item><title>Ether ETF approval expected</title><link>https://a.example/2</link><pubDate>${new Date(now-200_000).toUTCString()}</pubDate></item>
  </channel></rss>`;
  const items = by("coindesk").parse(body);
  check("rss parses 2", items.length === 2, `got ${items.length}`);
  check("rss unwraps CDATA + entities", items[0].headline === "SEC sues major exchange & wins", items[0].headline);
  check("rss parses pubDate", Math.abs(items[0].at - (now-100_000)) < 2000);
}

/* Garbage must not throw */
{
  for (const id of ["binance-announce","reddit-Bitcoin","4chan-biz","hn","coindesk"]) {
    let threw = false;
    try { by(id).parse("<<not json or xml>>"); } catch { threw = true; }
    check(`${id} survives garbage`, !threw);
  }
}

/* End to end through the poller, with fetch stubbed */
{
  rmSync("/tmp/sweep-checks/news-parse.json", { force: true });
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const ok = (t: string) => new Response(t, { status: 200 });
    if (u.includes("binance.com")) return ok(JSON.stringify({ data: { catalogs: [ { articles: [
      { title: "Binance Will Delist DOGEUSDT Perpetual Contract", code: "d1", releaseDate: now - 30_000 } ] } ] } }));
    if (u.includes("reddit.com")) return ok(JSON.stringify({ data: { children: Array.from({length: 12}, (_,i) => (
      { data: { title: `bitcoin thread ${i}`, permalink: `/r/z/${i}`, created_utc: (now-10_000)/1000, score: 1 } })) } }));
    if (u.includes("4cdn.org")) return ok(JSON.stringify([{ threads: [ { com: "BTC to the moon", time: Math.floor((now-5_000)/1000) } ] }]));
    if (u.includes("algolia")) return ok(JSON.stringify({ hits: [] }));
    return ok(`<rss><channel><item><title>Ethereum network halt reported</title><link>https://w/1</link><pubDate>${new Date(now-20_000).toUTCString()}</pubDate></item></channel></rss>`);
  }) as any;

  const { startNewsPoller, mentionVelocity } = await import("../lib/sweep/metrics/news-poller");
  const highs: string[] = [];
  const p = startNewsPoller({ onHigh: (h) => highs.push(h) });
  await p.pollNow();
  const st = p.status();
  p.stop();
  globalThis.fetch = real;

  check("no source errored", st.errors === "", st.errors);
  check("announcement + wires recorded", st.recorded >= 2, `recorded ${st.recorded}`);
  check("delisting flagged high", highs.some(h => /Delist/i.test(h)), highs.join(" | "));
  check("halt flagged high", highs.some(h => /halt/i.test(h)), highs.join(" | "));
  check("BTC mentions counted from forums", mentionVelocity("BTCUSDT") >= 1, String(mentionVelocity("BTCUSDT")));

  const items = existsSync("/tmp/sweep-checks/news-parse.json")
    ? JSON.parse(readFileSync("/tmp/sweep-checks/news-parse.json","utf8")) : [];
  check("store written", items.length >= 2, `${items.length} items`);
  check("no forum post entered the store", !items.some((i: any) => /thread \d|to the moon/i.test(i.headline)),
    items.map((i:any)=>i.headline).join(" | "));
  check("symbols tagged", items.some((i: any) => i.symbols.includes("ETHUSDT")), JSON.stringify(items.map((i:any)=>i.symbols)));

  // Second pass must add nothing: dedupe on headline.
  const p2 = startNewsPoller({});
  globalThis.fetch = ((async (url: any) => {
    const u = String(url);
    if (u.includes("binance.com")) return new Response(JSON.stringify({ data: { catalogs: [ { articles: [
      { title: "Binance Will Delist DOGEUSDT Perpetual Contract", code: "d1", releaseDate: now - 30_000 } ] } ] } }), { status: 200 });
    return new Response(`<rss><channel><item><title>Ethereum network halt reported</title><link>https://w/1</link><pubDate>${new Date(now-20_000).toUTCString()}</pubDate></item></channel></rss>`, { status: 200 });
  })) as any;
  await p2.pollNow();
  p2.stop();
  globalThis.fetch = real;
  const after = JSON.parse(readFileSync("/tmp/sweep-checks/news-parse.json","utf8"));
  check("re-poll records no duplicates", after.length === items.length, `${items.length} -> ${after.length}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall parser checks passed");
process.exit(fails ? 1 : 0);
}
main();
