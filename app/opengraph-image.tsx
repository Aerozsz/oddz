import { ImageResponse } from "next/og";
import { getOverview } from "@/features/overview/queries";
import { formatUSD } from "@/lib/utils";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Oddz — every prediction market, one dashboard";

const BG = "#0C0F13";
const FG = "#E9EDF2";
const MUTED = "#8A94A3";
const ACCENT = "#58AD8A";
const NEG = "#D17A71";

// The "Currents" mark (two offset YES/NO beams) and a faint sparkline, as data
// URIs (satori renders SVG reliably via <img>).
const ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><defs><linearGradient id="y" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0.12"/></linearGradient><linearGradient id="n" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="${NEG}"/><stop offset="1" stop-color="${NEG}" stop-opacity="0.12"/></linearGradient></defs><rect x="3" y="13" width="38" height="9" rx="4.5" fill="url(#y)"/><rect x="7" y="26" width="38" height="9" rx="4.5" fill="url(#n)"/></svg>`,
)}`;
const SPARK = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 360 120" preserveAspectRatio="none"><polyline points="0,100 40,92 80,96 120,78 160,84 200,64 240,70 280,44 320,52 360,26" fill="none" stroke="${ACCENT}" stroke-width="2"/></svg>`,
)}`;

export default async function OgImage() {
  const overview = await getOverview().catch(() => null);
  const stat =
    overview && overview.totalMarkets > 0
      ? `${formatUSD(overview.totalVolume)} volume · ${overview.totalMarkets.toLocaleString()} live markets`
      : "Live odds across Polymarket, Kalshi, Manifold & Metaculus";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          backgroundColor: BG,
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SPARK} width={720} height={240} style={{ position: "absolute", right: 0, bottom: 0, opacity: 0.5 }} alt="" />
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ICON} width={56} height={56} alt="" />
          <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -2, color: FG }}>oddz</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -2, color: FG, maxWidth: 820, lineHeight: 1.1 }}>
            Every prediction market. One dashboard.
          </div>
          <div style={{ fontSize: 28, color: MUTED }}>{stat}</div>
        </div>
      </div>
    ),
    size,
  );
}
