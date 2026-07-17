import type { Metadata } from "next";
import { brand } from "@/lib/brand";

export const metadata: Metadata = {
  title: "API docs",
  description: "Public JSON API for aggregated prediction-market data.",
};

const HOST = brand.url.replace(/\/$/, "");

const ENDPOINTS = [
  {
    method: "GET",
    path: "/api/v1/markets",
    desc: "List live markets across all venues, newest snapshot per market.",
    params: [
      ["q", "text search over question and category"],
      ["venue", "polymarket | kalshi | manifold | metaculus"],
      ["limit", "max rows, default 100, cap 500"],
      ["offset", "pagination offset"],
    ],
    example: `curl "${HOST}/api/v1/markets?venue=kalshi&limit=5"`,
  },
  {
    method: "GET",
    path: "/api/v1/markets/{id}/history",
    desc: "Price snapshots for one market, oldest first. `id` is `<venue>:<externalId>` (URL-encoded).",
    params: [["hours", "lookback window, default 168 (7d), cap 2160 (90d)"]],
    example: `curl "${HOST}/api/v1/markets/kalshi%3APRES28-DJT/history?hours=24"`,
  },
  {
    method: "GET",
    path: "/api/v1/arbitrage",
    desc: "Live cross-venue lock-in arbitrage opportunities, best edge first.",
    params: [
      ["minEdge", "minimum gross edge, default 0.005 (0.5%)"],
      ["limit", "max rows, default 50, cap 200"],
    ],
    example: `curl "${HOST}/api/v1/arbitrage?minEdge=0.01"`,
  },
  {
    method: "GET",
    path: "/api/v1/consensus",
    desc: "Volume-weighted fair-value odds per event and each venue's gap vs consensus.",
    params: [
      ["minEdge", "minimum max leg gap, default 0.02 (2pp)"],
      ["limit", "max rows, default 50, cap 200"],
    ],
    example: `curl "${HOST}/api/v1/consensus"`,
  },
  {
    method: "GET",
    path: "/api/v1/movers",
    desc: "Biggest YES-price swings over a window, all venues.",
    params: [
      ["hours", "lookback window, default 24, cap 720"],
      ["limit", "max rows, default 30, cap 200"],
    ],
    example: `curl "${HOST}/api/v1/movers?hours=6"`,
  },
  {
    method: "GET",
    path: "/api/badge/{id}",
    desc: "Embeddable live-odds SVG badge. Drop into any tweet, README, or blog as an image.",
    params: [["id", "`<venue>:<externalId>` (URL-encoded)"]],
    example: `<img src="${HOST}/api/badge/kalshi%3APRES28-DJT">`,
  },
  {
    method: "GET",
    path: "/api/health",
    desc: "Operational health: DB connectivity, per-venue freshness, last ingest run.",
    params: [],
    example: `curl "${HOST}/api/health"`,
  },
];

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          Aggregated prediction-market data as JSON. Anonymous callers get 30 requests/hour per
          IP; free keys 60/hour; pro keys 3,600/hour. Pass keys as{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">Authorization: Bearer oddz_...</code>.
          Rate-limit state is returned in <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">x-ratelimit-*</code>{" "}
          headers.
        </p>
      </div>

      {ENDPOINTS.map((e) => (
        <section key={e.path} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-xs text-emerald-300">
              {e.method}
            </span>
            <code className="font-mono text-sm text-zinc-100">{e.path}</code>
          </div>
          <p className="text-sm text-zinc-400">{e.desc}</p>
          {e.params.length > 0 && (
            <table className="w-full max-w-lg text-sm">
              <tbody>
                {e.params.map(([name, desc]) => (
                  <tr key={name} className="border-t border-border-subtle/60">
                    <td className="py-1 pr-4 font-mono text-xs text-zinc-300">{name}</td>
                    <td className="py-1 text-xs text-zinc-500">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">{e.example}</pre>
        </section>
      ))}

      <p className="text-sm text-zinc-500">
        Need a key or higher limits? Reach out — pro tier includes bulk history export.
      </p>
    </div>
  );
}
