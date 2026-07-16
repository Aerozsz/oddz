import Link from "next/link";
import { listArbitrage } from "@/features/arbitrage/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Arbitrage",
  description:
    "Risk-free cross-venue arbitrage: buy YES on one venue and NO on another for a guaranteed payout under $1.",
};

export default async function ArbitragePage() {
  const arbs = await listArbitrage(0.005, 50);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arbitrage</h1>
        <p className="max-w-2xl text-sm text-zinc-500">
          Same event, two venues, mispriced. Buy YES on the cheaper venue and NO on the pricier one
          — you pay under $1 for a guaranteed $1 payout. Edge shown is gross, before venue fees and
          slippage.
        </p>
      </div>

      {arbs.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
          No live arbitrage right now — venues are priced in line. This tightens up fast when news
          hits; check back, or watch the divergence view for gaps opening.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {arbs.map((a) => (
            <div
              key={a.eventId}
              className="flex flex-col gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/events/${encodeURIComponent(a.eventId)}`}
                  className="text-zinc-100 hover:text-white"
                >
                  {a.title}
                </Link>
                {a.category && <div className="text-xs text-zinc-500">{a.category}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-zinc-400">Buy</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">
                    YES
                  </span>
                  <span className="text-zinc-400">on</span>
                  <a href={a.buyYes.sourceUrl} target="_blank" rel="noopener noreferrer">
                    <VenueBadge venue={a.buyYes.venue} />
                  </a>
                  <span className="font-mono text-zinc-300">@ {formatPct(a.yesCost)}</span>
                  <span className="text-zinc-600">+</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-medium text-red-300">
                    NO
                  </span>
                  <span className="text-zinc-400">on</span>
                  <a href={a.buyNo.sourceUrl} target="_blank" rel="noopener noreferrer">
                    <VenueBadge venue={a.buyNo.venue} />
                  </a>
                  <span className="font-mono text-zinc-300">@ {formatPct(a.noCost)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end">
                <div className="text-right">
                  <div className="font-mono text-2xl font-semibold text-emerald-300">
                    +{formatPct(a.edge)}
                  </div>
                  <div className="text-xs text-zinc-500">locked edge</div>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  cost <span className="font-mono text-zinc-400">${a.totalCost.toFixed(3)}</span>
                  <br />
                  per $1 payout
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
