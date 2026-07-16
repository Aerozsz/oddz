import Link from "next/link";
import { formatPct } from "@/lib/utils";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import type { DivergenceRow } from "../queries";

export function DivergenceTable({ rows }: { rows: DivergenceRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
        No matched events across venues yet. The matcher needs at least two venues
        listing the same question — once the snapshot worker has run a few times
        and the canonical-key matcher reconciles, divergences appear here.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
          <tr>
            <th className="px-3 py-2 text-left">Event</th>
            <th className="px-3 py-2 text-left">Venues</th>
            <th className="px-3 py-2 text-right">Spread</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.eventId} className="border-t border-zinc-800 hover:bg-zinc-900/40">
              <td className="px-3 py-2">
                <Link
                  href={`/events/${encodeURIComponent(r.eventId)}`}
                  className="block text-zinc-100 hover:text-white"
                >
                  {r.title}
                  {r.category && <div className="text-xs text-zinc-500">{r.category}</div>}
                </Link>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {r.legs
                    .slice()
                    .sort((a, b) => b.yes - a.yes)
                    .map((leg) => (
                      <Link
                        key={leg.marketId}
                        href={`/markets/${encodeURIComponent(leg.marketId)}`}
                        className="inline-flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 hover:border-zinc-600"
                      >
                        <VenueBadge venue={leg.venue} />
                        <span className="font-mono text-emerald-300">{formatPct(leg.yes)}</span>
                      </Link>
                    ))}
                </div>
              </td>
              <td className="px-3 py-2 text-right">
                <span className="rounded bg-amber-500/15 px-2 py-1 font-mono text-amber-300">
                  {formatPct(r.spread)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
