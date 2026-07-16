import { ImageResponse } from "next/og";
import { getMarket, getMarketHistory } from "@/features/markets/queries";
import { formatPct } from "@/lib/utils";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Live prediction-market odds on Oddz";

const VENUE_COLORS: Record<string, string> = {
  polymarket: "#60a5fa",
  kalshi: "#34d399",
  manifold: "#fbbf24",
  metaculus: "#c084fc",
};

export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const market = await getMarket(decodeURIComponent(id)).catch(() => null);

  const question = market?.question ?? "Prediction market odds";
  const venueName = market?.venueName ?? "";
  const venueColor = VENUE_COLORS[market?.venue ?? ""] ?? "#a1a1aa";

  let yes: number | null = null;
  if (market) {
    const history = await getMarketHistory(market.id, 24).catch(() => []);
    yes = history.at(-1)?.prices?.[0] ?? null;
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          backgroundColor: "#09090b",
          color: "#f4f4f5",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>oddz</div>
          {venueName && (
            <div
              style={{
                display: "flex",
                fontSize: 26,
                color: venueColor,
                border: `2px solid ${venueColor}`,
                borderRadius: 8,
                padding: "4px 16px",
              }}
            >
              {venueName}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            fontSize: question.length > 80 ? 44 : 56,
            fontWeight: 600,
            lineHeight: 1.2,
            maxWidth: 1000,
          }}
        >
          {question.slice(0, 140)}
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          {yes !== null ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 28, color: "#a1a1aa" }}>YES</div>
              <div style={{ display: "flex", fontSize: 96, fontWeight: 700, color: "#34d399" }}>
                {formatPct(yes)}
              </div>
            </div>
          ) : (
            <div />
          )}
          <div style={{ display: "flex", fontSize: 26, color: "#71717a" }}>
            Live odds across every prediction market
          </div>
        </div>
      </div>
    ),
    size,
  );
}
