import { cookies } from "next/headers";
import { listMarkets, listResolvingSoon } from "@/features/markets/queries";
import { getWatchedIds } from "@/features/watchlist/queries";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

/** RFC 5545 text escaping. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function dt(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * ICS feed of resolution dates. Personal when a watchlist exists (wid
 * cookie), otherwise the biggest dated books. Subscribe from any calendar
 * app: /api/calendar
 */
export async function GET() {
  const jar = await cookies();
  const wid = jar.get("wid")?.value ?? null;
  const watched = await getWatchedIds(wid);

  const rows =
    watched.size > 0
      ? (await listMarkets({ ids: [...watched], limit: 200 })).filter((r) => r.endsAt)
      : await listResolvingSoon(100);

  const now = new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${brand.name}//resolution-calendar//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(brand.name)} resolutions`,
  ];

  for (const r of rows) {
    if (!r.endsAt) continue;
    const ends = new Date(r.endsAt);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${esc(r.id)}@${new URL(brand.url).hostname}`,
      `DTSTAMP:${dt(now)}`,
      `DTSTART:${dt(ends)}`,
      `SUMMARY:${esc(`Resolves: ${r.question}`)}`,
      `DESCRIPTION:${esc(`${r.venueName} market resolves. Latest odds and history: ${brand.url}/markets/${encodeURIComponent(r.id)}`)}`,
      `URL:${esc(`${brand.url}/markets/${encodeURIComponent(r.id)}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="oddz-resolutions.ics"',
      "cache-control": "private, max-age=300",
    },
  });
}
