import Link from "next/link";
import { listTrending } from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Trending",
  description: "What's hot right now — markets ranked by a blend of price movement and volume.",
};

export default async function TrendingPage() {
  const rows = await listTrending(24, 40);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
        <p className="text-sm text-zinc-500">
          What&apos;s hot right now — real odds movement with real money behind it.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
          Nothing trending yet — needs a couple of snapshots to measure movement.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">YES</th>
                <th className="px-3 py-2 text-right">24h move</th>
                <th className="px-3 py-2 text-right">Volume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/markets/${encodeURIComponent(r.id)}`}
                      className="block text-zinc-100 hover:text-white"
                    >
                      <span className="line-clamp-2">{r.question}</span>
                      {r.category && <span className="text-xs text-zinc-500">{r.category}</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <VenueBadge venue={r.venue} name={r.venueName} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-300">
                    {formatPct(r.yes)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right font-mono",
                      r.priceMove >= 0.001 ? "text-zinc-200" : "text-zinc-500",
                    )}
                  >
                    {(r.priceMove * 100).toFixed(1)}pp
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(r.volume)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
