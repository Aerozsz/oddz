import Link from "next/link";
import { notFound } from "next/navigation";
import { EventOverlayChart } from "@/features/charts/EventOverlayChart";
import { getEvent, getEventHistory } from "@/features/events/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(decodeURIComponent(id));
  if (!event) return { title: "Event not found" };
  return {
    title: `${event.title} — cross-venue odds`,
    description: `Compare live odds for "${event.title}" across ${event.legs.length} prediction market venues.`,
  };
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const event = await getEvent(decoded);
  if (!event) notFound();

  const history = await getEventHistory(decoded, 24 * 7);
  const venuesWithData = Array.from(
    new Set(event.legs.filter((l) => l.yes !== null).map((l) => l.venue)),
  );

  const priced = event.legs.filter((l) => l.yes !== null) as (typeof event.legs[number] & {
    yes: number;
  })[];
  const spread =
    priced.length >= 2 ? Math.max(...priced.map((l) => l.yes)) - Math.min(...priced.map((l) => l.yes)) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/divergence" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Back to divergence
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{event.title}</h1>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          {event.category && <span>{event.category}</span>}
          <span>
            {event.legs.length} venue listing{event.legs.length === 1 ? "" : "s"}
          </span>
          {spread !== null && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-amber-300">
              spread {formatPct(spread)}
            </span>
          )}
        </div>
      </div>

      <EventOverlayChart data={history} venues={venuesWithData} />

      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Venue</th>
              <th className="px-3 py-2 text-right">YES</th>
              <th className="px-3 py-2 text-right">24h Vol</th>
              <th className="px-3 py-2 text-right">Liquidity</th>
              <th className="px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {event.legs
              .slice()
              .sort((a, b) => (b.yes ?? -1) - (a.yes ?? -1))
              .map((leg) => (
                <tr key={leg.marketId} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <td className="px-3 py-2">
                    <Link
                      href={`/markets/${encodeURIComponent(leg.marketId)}`}
                      className="inline-flex items-center gap-2"
                    >
                      <VenueBadge venue={leg.venue} name={leg.venueName} />
                      <span className="text-xs text-zinc-500">{leg.slug}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-300">
                    {formatPct(leg.yes)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(leg.volume)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(leg.liquidity)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <a
                      href={leg.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Trade ↗
                    </a>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
