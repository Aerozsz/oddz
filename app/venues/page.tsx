import Link from "next/link";
import { PageHeader } from "@/features/layout/PageHeader";
import { getVenueStats } from "@/features/venues/queries";
import { formatPct, formatUSD, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Venues",
  description:
    "Prediction-market venues compared: live volume, liquidity, open interest, average vig, and settlement model.",
};

/** Facts a bettor weighs before picking a venue. Static, venue-level. */
const VENUE_META: Record<
  string,
  { settlement: string; money: string; fees: string }
> = {
  polymarket: {
    settlement: "UMA optimistic oracle",
    money: "Real money (USDC, Polygon)",
    fees: "No trading fee; gas + spread",
  },
  kalshi: {
    settlement: "CFTC-regulated exchange",
    money: "Real money (USD)",
    fees: "Per-contract trading fee",
  },
  manifold: {
    settlement: "Creator resolves",
    money: "Play money (mana)",
    fees: "None",
  },
  metaculus: {
    settlement: "Community / admin",
    money: "Reputation only",
    fees: "None",
  },
};

export default async function VenuesPage() {
  const stats = await getVenueStats();
  const totalVolume = stats.reduce((a, s) => a + s.volume, 0) || 1;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Venues"
        context={<>live snapshot totals</>}
        blurb={<>The venues compared head-to-head — where the money, the liquidity, and the cheapest books
          are right now. Numbers come from each market&apos;s latest snapshot.</>}
      />

      {/* Volume share strip */}
      <div className="flex flex-col gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          Volume share
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-track">
          {stats.map((s, i) => (
            <div
              key={s.venue}
              title={`${s.name}: ${formatUSD(s.volume)} (${((s.volume / totalVolume) * 100).toFixed(1)}%)`}
              className="grow-x h-full"
              style={{
                width: `${(s.volume / totalVolume) * 100}%`,
                backgroundColor: `rgb(var(--c-accent) / ${1 - i * 0.22})`,
              }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {stats.map((s, i) => (
            <span key={s.venue} className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: `rgb(var(--c-accent) / ${1 - i * 0.22})` }}
              />
              {s.name} {((s.volume / totalVolume) * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </div>

      {/* Comparison table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="bg-surface font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Venue</th>
              <th className="px-3 py-2 text-right">Open markets</th>
              <th className="px-3 py-2 text-right">24h volume</th>
              <th className="px-3 py-2 text-right">Liquidity</th>
              <th className="px-3 py-2 text-right">Open interest</th>
              <th className="px-3 py-2 text-right">Avg vig</th>
              <th className="px-3 py-2 text-left">Money</th>
              <th className="px-3 py-2 text-left">Settlement</th>
              <th className="px-3 py-2 text-right">Fresh</th>
            </tr>
          </thead>
          <tbody className="stagger">
            {stats.map((s) => {
              const meta = VENUE_META[s.venue];
              return (
                <tr key={s.venue} className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]">
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/venues/${encodeURIComponent(s.venue)}`}
                      className="text-sm font-medium text-fg hover:text-white"
                    >
                      {s.name}
                    </Link>
                    {meta && <div className="text-[11px] text-muted">{meta.fees}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg">
                    {s.open.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-fg">
                    {formatUSD(s.volume)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg-dim">
                    {s.liquidity > 0 ? formatUSD(s.liquidity) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg-dim">
                    {s.openInterest > 0 ? formatUSD(s.openInterest) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {s.avgVig === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={s.avgVig <= 0.04 ? "text-accent" : "text-neg"}>
                        {formatPct(Math.max(0, s.avgVig))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted">{meta?.money ?? "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted">{meta?.settlement ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[11px] text-muted">
                    {s.latestSnapshot ? timeAgo(s.latestSnapshot) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted">
        Vig is the average overround on multi-outcome books — the built-in cost of betting there.
        Play-money and reputation venues are shown because their forecasts carry signal, not
        because you can arb them.
      </p>
    </div>
  );
}
