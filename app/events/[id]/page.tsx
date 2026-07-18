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
        <Link href="/divergence" className="link self-start text-xs text-muted hover:text-fg">
          ← Back to divergence
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{event.title}</h1>
        <div className="flex items-center gap-3 text-sm text-muted">
          {event.category && <span>{event.category}</span>}
          <span>
            {event.legs.length} venue listing{event.legs.length === 1 ? "" : "s"}
          </span>
          {spread !== null && (
            <span
              className="rounded px-2 py-0.5 font-mono text-xs tabular-nums"
              style={{
                backgroundColor:
                  spread > 0.1 ? "rgb(var(--c-neg) / 0.15)" : "rgb(var(--c-track))",
                color: spread > 0.1 ? "rgb(var(--c-neg))" : "rgb(var(--c-fg))",
              }}
            >
              spread {formatPct(spread)}
            </span>
          )}
        </div>
        {/* 0–100% strip: where each venue prices this event */}
        {priced.length >= 2 && (
          <div className="relative mt-1 h-5 max-w-xl">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-track" />
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
              style={{
                left: `${Math.min(...priced.map((l) => l.yes)) * 100}%`,
                width: `${Math.max(1, spread! * 100)}%`,
                backgroundColor:
                  spread! > 0.1 ? "rgb(var(--c-neg) / 0.7)" : "rgb(var(--c-accent) / 0.7)",
              }}
            />
            {priced.map((l) => (
              <span
                key={l.marketId}
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[rgb(var(--c-bg))] bg-muted"
                style={{ left: `${l.yes * 100}%` }}
                title={`${l.venueName}: ${formatPct(l.yes)}`}
              />
            ))}
          </div>
        )}
      </div>

      <EventOverlayChart data={history} venues={venuesWithData} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead className="bg-zinc-900/60 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
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
                <tr key={leg.marketId} className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]">
                  <td className="px-3 py-2">
                    <Link
                      href={`/markets/${encodeURIComponent(leg.marketId)}`}
                      className="inline-flex items-center gap-2"
                    >
                      <VenueBadge venue={leg.venue} name={leg.venueName} />
                      <span className="text-xs text-zinc-500">{leg.slug}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-accent">
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
                      className="inline-flex rounded-full border border-border px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-[rgb(var(--c-accent))]/50 hover:text-fg"
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
