import { getMarket, getMarketHistory } from "@/features/markets/queries";

export const runtime = "nodejs";
export const revalidate = 60;

const VENUE_COLOR: Record<string, string> = {
  polymarket: "#60a5fa",
  kalshi: "#34d399",
  manifold: "#fbbf24",
  metaculus: "#c084fc",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Embeddable live odds badge as SVG. Drop into any tweet, README, or blog:
 *   <img src="https://<host>/api/badge/<venue>:<externalId>">
 * A distribution flywheel — every embed is a backlink advertising the odds.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const market = await getMarket(decodeURIComponent(id)).catch(() => null);

  const W = 340;
  const H = 76;
  let svg: string;

  if (!market) {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="8" fill="#18181b"/><text x="16" y="43" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" fill="#a1a1aa">Market not found</text></svg>`;
  } else {
    const history = await getMarketHistory(market.id, 24).catch(() => []);
    const yes = history.at(-1)?.prices?.[0];
    const pct = yes !== undefined && Number.isFinite(yes) ? `${(yes * 100).toFixed(0)}%` : "—";
    const color = VENUE_COLOR[market.venue] ?? "#a1a1aa";
    const q = esc(market.question.length > 46 ? market.question.slice(0, 45) + "…" : market.question);
    const venue = esc(market.venueName);

    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="${esc(market.question)} — ${pct} YES">
  <rect width="${W}" height="${H}" rx="8" fill="#09090b" stroke="#27272a"/>
  <circle cx="20" cy="24" r="4" fill="${color}"/>
  <text x="32" y="28" font-family="ui-monospace,monospace" font-size="12" fill="${color}">${venue}</text>
  <text x="${W - 16}" y="28" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#52525b">oddz</text>
  <text x="16" y="50" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" fill="#f4f4f5">${q}</text>
  <text x="16" y="68" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#71717a">YES</text>
  <text x="${W - 16}" y="68" text-anchor="end" font-family="ui-monospace,monospace" font-size="20" font-weight="700" fill="#34d399">${pct}</text>
</svg>`;
  }

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
      "access-control-allow-origin": "*",
    },
  });
}
