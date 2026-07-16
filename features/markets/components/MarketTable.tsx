import Link from "next/link";
import type { MarketRow } from "../queries";
import { StarButton } from "@/features/watchlist/StarButton";
import { formatUSD, timeAgo } from "@/lib/utils";
import { PriceCell } from "./PriceCell";
import { Sparkline } from "./Sparkline";
import { VenueBadge } from "./VenueBadge";

export function MarketTable({
  rows,
  sparklines,
  watchedIds,
}: {
  rows: MarketRow[];
  sparklines?: Map<string, number[]>;
  watchedIds?: Set<string>;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
        No markets yet. Run the snapshot worker (
        <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">npm run snapshot:once</code>) to
        ingest live data.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
          <tr>
            <th className="w-8 px-2 py-2"></th>
            <th className="px-3 py-2 text-left">Market</th>
            <th className="px-3 py-2 text-left">Venue</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-center">Trend</th>
            <th className="px-3 py-2 text-right">24h Vol</th>
            <th className="px-3 py-2 text-right">Liquidity</th>
            <th className="px-3 py-2 text-right">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
              <td className="px-2 py-2 text-center">
                <StarButton marketId={m.id} initialWatched={watchedIds?.has(m.id) ?? false} />
              </td>
              <td className="px-3 py-2">
                <Link
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="block text-zinc-100 hover:text-white"
                >
                  <div className="line-clamp-2">{m.question}</div>
                  {m.category && (
                    <div className="mt-0.5 text-xs text-zinc-500">{m.category}</div>
                  )}
                </Link>
              </td>
              <td className="px-3 py-2">
                <VenueBadge venue={m.venue} name={m.venueName} />
              </td>
              <td className="px-3 py-2 text-right">
                <PriceCell outcomes={m.outcomes} prices={m.prices} />
              </td>
              <td className="px-3 py-2 text-center">
                <Sparkline values={sparklines?.get(m.id) ?? []} />
              </td>
              <td className="px-3 py-2 text-right font-mono text-zinc-300">
                {formatUSD(m.volume)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-zinc-300">
                {formatUSD(m.liquidity)}
              </td>
              <td className="px-3 py-2 text-right text-xs text-zinc-500">
                {timeAgo(m.lastSeenAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
