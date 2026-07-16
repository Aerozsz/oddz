import Link from "next/link";
import { getOverview } from "@/features/overview/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Overview",
  description: "Total volume, venue dominance, and category breakdown across every prediction market.",
};

const VENUE_BAR: Record<string, string> = {
  polymarket: "bg-blue-400",
  kalshi: "bg-emerald-400",
  manifold: "bg-amber-400",
  metaculus: "bg-purple-400",
};

export default async function OverviewPage() {
  const o = await getOverview();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-zinc-500">The whole prediction-market landscape, at a glance.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total volume" value={formatUSD(o.totalVolume)} />
        <Stat label="Live markets" value={o.totalMarkets.toLocaleString()} />
        <Stat label="Venues" value={String(o.venues.length)} />
        <Stat
          label="Top venue"
          value={o.venues[0] ? o.venues[0].venue : "—"}
          sub={o.venues[0] ? `${(o.venues[0].share * 100).toFixed(0)}% of volume` : undefined}
        />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Venue dominance
        </h2>
        {o.totalVolume > 0 && (
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
            {o.venues.map((v) => (
              <div
                key={v.venue}
                className={VENUE_BAR[v.venue] ?? "bg-zinc-500"}
                style={{ width: `${v.share * 100}%` }}
                title={`${v.venue}: ${(v.share * 100).toFixed(1)}%`}
              />
            ))}
          </div>
        )}
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">Markets</th>
                <th className="px-3 py-2 text-right">Volume</th>
                <th className="px-3 py-2 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {o.venues.map((v) => (
                <tr key={v.venue} className="border-t border-zinc-800">
                  <td className="px-3 py-2">
                    <Link href={`/markets?venue=${v.venue}`}>
                      <VenueBadge venue={v.venue} />
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{v.markets}</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(v.volume)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">
                    {(v.share * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {o.categories.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Top categories by volume
          </h2>
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-right">Markets</th>
                  <th className="px-3 py-2 text-right">Volume</th>
                </tr>
              </thead>
              <tbody>
                {o.categories.map((c) => (
                  <tr key={c.category} className="border-t border-zinc-800">
                    <td className="px-3 py-2">
                      <Link
                        href={`/markets?cat=${encodeURIComponent(c.category)}`}
                        className="capitalize text-zinc-200 hover:text-white"
                      >
                        {c.category}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">{c.markets}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">
                      {formatUSD(c.volume)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
      {sub && <div className="text-xs capitalize text-zinc-500">{sub}</div>}
    </div>
  );
}
