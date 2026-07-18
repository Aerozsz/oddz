import type { Metadata } from "next";
import { brand } from "@/lib/brand";

export const metadata: Metadata = {
  title: "API docs",
  description: "Public JSON API for aggregated prediction-market data.",
};

const HOST = brand.url.replace(/\/$/, "");

// Code blocks stay dark in BOTH themes (per brand spec), so hard-code colours.
const CODE_BG = "#0A0D10";
const C_KEY = "#8A94A3"; // muted
const C_STR = "#2FD483"; // green
const C_NUM = "#E7B740"; // amber
const C_PUNC = "#5D6672";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Tiny, safe JSON syntax highlighter. Input is a trusted static string; we
 * still HTML-escape before wrapping tokens in coloured spans.
 */
function highlightJson(json: string): string {
  return esc(json).replace(
    /("(\\.|[^"\\])*"\s*:)|("(\\.|[^"\\])*")|(\b-?\d+(\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],])/g,
    (m, key, _k1, str, _s1, num, _n1, lit, punc) => {
      if (key) return `<span style="color:${C_KEY}">${key}</span>`;
      if (str) return `<span style="color:${C_STR}">${str}</span>`;
      if (num) return `<span style="color:${C_NUM}">${num}</span>`;
      if (lit) return `<span style="color:${C_NUM}">${lit}</span>`;
      if (punc) return `<span style="color:${C_PUNC}">${punc}</span>`;
      return m;
    },
  );
}

function CodeBlock({ command, response }: { command: string; response?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#1A212B]" style={{ background: CODE_BG }}>
      <div className="flex items-center gap-1.5 border-b border-[#1A212B] px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#F0645A" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#E7B740" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#2FD483" }} />
        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5D6672]">
          shell
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed">
        <code style={{ color: "#E9EDF2" }}>
          <span style={{ color: C_STR }}>curl</span> {command}
        </code>
      </pre>
      {response && (
        <pre
          className="overflow-x-auto border-t border-[#1A212B] px-4 py-3 font-mono text-xs leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlightJson(response) }}
        />
      )}
    </div>
  );
}

const SAMPLE_RESPONSE = `{
  "data": [
    {
      "id": "kalshi:PRES28-DJT",
      "venue": "kalshi",
      "question": "Will Donald Trump win the 2028 election?",
      "yes": 0.41,
      "volume": 1284000,
      "updatedAt": "2026-07-18T12:00:00Z"
    }
  ],
  "count": 1,
  "nextOffset": null
}`;

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
    example: `"${HOST}/api/v1/markets?venue=kalshi&limit=5"`,
  },
  {
    method: "GET",
    path: "/api/v1/markets/{id}/history",
    desc: "Price snapshots for one market, oldest first. `id` is `<venue>:<externalId>` (URL-encoded).",
    params: [["hours", "lookback window, default 168 (7d), cap 2160 (90d)"]],
    example: `"${HOST}/api/v1/markets/kalshi%3APRES28-DJT/history?hours=24"`,
  },
  {
    method: "GET",
    path: "/api/v1/arbitrage",
    desc: "Live cross-venue lock-in arbitrage opportunities, best edge first.",
    params: [
      ["minEdge", "minimum gross edge, default 0.005 (0.5%)"],
      ["limit", "max rows, default 50, cap 200"],
    ],
    example: `"${HOST}/api/v1/arbitrage?minEdge=0.01"`,
  },
  {
    method: "GET",
    path: "/api/v1/consensus",
    desc: "Volume-weighted fair-value odds per event and each venue's gap vs consensus.",
    params: [
      ["minEdge", "minimum max leg gap, default 0.02 (2pp)"],
      ["limit", "max rows, default 50, cap 200"],
    ],
    example: `"${HOST}/api/v1/consensus"`,
  },
  {
    method: "GET",
    path: "/api/v1/movers",
    desc: "Biggest YES-price swings over a window, all venues.",
    params: [
      ["hours", "lookback window, default 24, cap 720"],
      ["limit", "max rows, default 30, cap 200"],
    ],
    example: `"${HOST}/api/v1/movers?hours=6"`,
  },
  {
    method: "GET",
    path: "/api/badge/{id}",
    desc: "Embeddable live-odds SVG badge. Drop into any tweet, README, or blog as an image.",
    params: [["id", "`<venue>:<externalId>` (URL-encoded)"]],
    example: `"${HOST}/api/badge/kalshi%3APRES28-DJT"`,
  },
  {
    method: "GET",
    path: "/api/health",
    desc: "Operational health: DB connectivity, per-venue freshness, last ingest run.",
    params: [],
    example: `"${HOST}/api/health"`,
  },
];

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Aggregated prediction-market data as JSON. Anonymous callers get 30 requests/hour per IP;
          free keys 60/hour; pro keys 3,600/hour.
        </p>
      </div>

      {/* Usage card */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Anonymous tier
            </span>
            <span className="font-mono text-xs tabular-nums text-muted">0 / 30 per hour</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-track">
            <div className="h-full rounded-full bg-accent" style={{ width: "4%" }} />
          </div>
          <p className="text-xs text-muted">
            No key needed to start. Rate-limit state comes back in{" "}
            <code className="rounded bg-track px-1 py-0.5 text-[11px]">x-ratelimit-*</code> headers.
          </p>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            API key
          </span>
          <div className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg px-3 py-2">
            <code className="font-mono text-sm text-fg">oddz_••••••••••••••••</code>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              Request access
            </span>
          </div>
          <p className="text-xs text-muted">
            Pass as{" "}
            <code className="rounded bg-track px-1 py-0.5 text-[11px]">
              Authorization: Bearer oddz_…
            </code>
            . Pro tier includes bulk history export.
          </p>
        </div>
      </div>

      {/* Quickstart */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Quickstart</h2>
        <CodeBlock command={`"${HOST}/api/v1/markets?venue=kalshi&limit=1"`} response={SAMPLE_RESPONSE} />
      </section>

      {/* Endpoints */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Endpoints</h2>
        {ENDPOINTS.map((e) => (
          <div key={e.path} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center gap-2">
              <span className="rounded bg-accent/15 px-2 py-0.5 font-mono text-xs text-accent">
                {e.method}
              </span>
              <code className="font-mono text-sm text-fg">{e.path}</code>
            </div>
            <p className="text-sm text-muted">{e.desc}</p>
            {e.params.length > 0 && (
              <table className="w-full max-w-lg text-sm">
                <tbody>
                  {e.params.map(([name, desc]) => (
                    <tr key={name} className="border-t border-border-subtle/60">
                      <td className="py-1 pr-4 font-mono text-xs text-fg">{name}</td>
                      <td className="py-1 text-xs text-muted">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <CodeBlock command={e.example} />
          </div>
        ))}
      </section>

      <p className="text-sm text-muted">
        Need a key or higher limits? Reach out — pro tier includes bulk history export.
      </p>
    </div>
  );
}
