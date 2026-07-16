import Link from "next/link";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { listMovers } from "@/features/markets/queries";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Movers",
  description: "Biggest prediction-market odds moves in the last 24 hours, across all venues.",
};

export default async function MoversPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string }>;
}) {
  const sp = await searchParams;
  const hours = [6, 24, 168].includes(Number(sp.h)) ? Number(sp.h) : 24;
  const rows = await listMovers(hours, 30);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Movers</h1>
          <p className="text-sm text-zinc-500">Biggest odds swings, all venues.</p>
        </div>
        <div className="flex gap-1 text-xs">
          {[6, 24, 168].map((h) => (
            <Link
              key={h}
              href={`/movers?h=${h}` as never}
              className={cn(
                "rounded border px-2 py-1",
                h === hours
                  ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                  : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
              )}
            >
              {h === 168 ? "7d" : `${h}h`}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
          No moves yet in this window — needs at least two snapshots per market.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">Then → Now</th>
                <th className="px-3 py-2 text-right">Δ</th>
                <th className="px-3 py-2 text-right">24h Vol</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <td className="px-3 py-2">
                    <Link
                      href={`/markets/${encodeURIComponent(m.id)}`}
                      className="block text-zinc-100 hover:text-white"
                    >
                      <span className="line-clamp-2">{m.question}</span>
                      {m.category && <span className="text-xs text-zinc-500">{m.category}</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <VenueBadge venue={m.venue} name={m.venueName} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatPct(m.yesThen)} → {formatPct(m.yesNow)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right font-mono",
                      m.delta >= 0 ? "text-emerald-300" : "text-red-300",
                    )}
                  >
                    {m.delta >= 0 ? "+" : ""}
                    {(m.delta * 100).toFixed(1)}pp
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(m.volume)}
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
