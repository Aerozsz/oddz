import Link from "next/link";
import { PageHeader } from "@/features/layout/PageHeader";
import { listYields } from "@/features/yields/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Yields",
  description:
    "The bond desk of prediction markets: near-certain favorites resolving soon, ranked by annualized return.",
};

function fmtDays(d: number): string {
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

/** Rough risk read from what we can see. Honest, mechanical, explained below. */
function riskLabel(r: { price: number; daysLeft: number; liquidity: number | null }) {
  let score = 0;
  if (r.price < 0.9) score++;
  if (r.daysLeft > 21) score++;
  if (r.liquidity !== null && r.liquidity < 1_000) score++;
  if (r.liquidity === null) score++;
  return score <= 1
    ? { label: "lower", cls: "bg-accent/15 text-accent" }
    : score === 2
      ? { label: "mid", cls: "bg-track text-fg-dim" }
      : { label: "higher", cls: "bg-neg/15 text-neg" };
}

export default async function YieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const sp = await searchParams;
  const maxDays = [14, 30, 60, 90].includes(Number(sp.d)) ? Number(sp.d) : 30;
  const rows = await listYields({ maxDays });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Yields"
        context={
          <span className="flex gap-1 normal-case tracking-normal">
            {[14, 30, 60, 90].map((d) => (
              <Link
                key={d}
                href={`/yields?d=${d}` as never}
                className={cn(
                  "rounded-full border px-3 py-1 font-mono text-xs",
                  d === maxDays
                    ? "border-transparent bg-fg text-bg"
                    : "border-border text-muted hover:border-[rgb(var(--c-accent))]/40",
                )}
              >
                ≤{d}D
              </Link>
            ))}
          </span>
        }
        blurb={<>The bond desk: near-certain favorites resolving soon. Buy the favorite, collect the
          spread to $1 at resolution. APR assumes it resolves as priced —{" "}
          <span className="text-fg-dim">the yield is real, and so is the tail risk.</span></>}
      />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No favorites ≥85% resolving inside {maxDays} days right now.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead className="bg-surface font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">Buy</th>
                <th className="px-3 py-2 text-right">To $1</th>
                <th className="px-3 py-2 text-right">APR</th>
                <th className="px-3 py-2 text-right">Resolves</th>
                <th className="px-3 py-2 text-right">Liquidity</th>
                <th className="px-3 py-2 text-right">Risk</th>
              </tr>
            </thead>
            <tbody className="stagger">
              {rows.map((r) => {
                const risk = riskLabel(r);
                return (
                  <tr key={r.id} className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]">
                    <td className="max-w-[380px] px-3 py-2.5">
                      <Link
                        href={`/markets/${encodeURIComponent(r.id)}`}
                        className="block text-fg hover:text-white"
                      >
                        <span className="line-clamp-2">{r.question}</span>
                        {r.category && <span className="text-xs text-muted">{r.category}</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <VenueBadge venue={r.venue} name={r.venueName} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono text-xs font-semibold",
                          r.side === "YES" ? "bg-accent/15 text-accent" : "bg-neg/15 text-neg",
                        )}
                      >
                        {r.side}
                      </span>
                      <span className="ml-2 font-mono tabular-nums text-fg">
                        {formatPct(r.price)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg-dim">
                      +{formatPct(r.ret)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-accent">
                      {r.apr >= 10 ? `${r.apr.toFixed(0)}×` : formatPct(r.apr)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg-dim">
                      {fmtDays(r.daysLeft)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted">
                      {r.liquidity !== null ? formatUSD(r.liquidity) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={cn("rounded px-2 py-0.5 font-mono text-[10px] uppercase", risk.cls)}>
                        {risk.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-3xl text-xs text-muted">
        <span className="text-fg-dim">What this number is:</span> price appreciation to $1 at
        settlement — buy the favorite below $1, collect the difference if it resolves as priced.
        APR is simple annualization of that gross gain, before fees and slippage.{" "}
        <span className="text-fg-dim">What it is not:</span> venue reward programs. Some venues
        (e.g. Polymarket) pay additional rewards on select markets; those schedules aren&apos;t in
        our data feeds, so where they apply the true total return is higher than shown — check the
        market page on the venue. Risk is mechanical: price further from certainty, longer to
        resolution, or thin/unknown liquidity each raise it. A 95% favorite still loses 1 time in
        20 — size accordingly.
      </p>
    </div>
  );
}
