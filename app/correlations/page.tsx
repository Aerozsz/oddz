import Link from "next/link";
import { PageHeader } from "@/features/layout/PageHeader";
import { getCorrelationMatrix } from "@/features/correlations/queries";
import { EdgeFallback } from "@/features/markets/components/EdgeFallback";
import { VenueBadge } from "@/features/markets/components/VenueBadge";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export const metadata = {
  title: "Correlations",
  description:
    "Which prediction markets move together — pairwise correlation of hourly odds changes across the biggest books.",
};

function cellColor(rho: number): string {
  const alpha = Math.min(Math.abs(rho), 1) * 0.85;
  return rho >= 0
    ? `rgb(var(--c-accent) / ${alpha.toFixed(2)})`
    : `rgb(var(--c-neg) / ${alpha.toFixed(2)})`;
}

function short(q: string, n = 26): string {
  return q.length <= n ? q : q.slice(0, n - 1).trimEnd() + "…";
}

export default async function CorrelationsPage() {
  const { markets, cells, hours } = await getCorrelationMatrix(72, 16);
  const byPair = new Map(cells.map((c) => [`${c.a}|${c.b}`, c]));
  const get = (a: string, b: string) => byPair.get(`${a}|${b}`) ?? byPair.get(`${b}|${a}`);

  const strongest = [...cells]
    .filter((c) => Math.abs(c.rho) >= 0.3)
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
    .slice(0, 8);
  const title = new Map(markets.map((m) => [m.id, m.question]));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Correlations"
        context={<>{hours}h · hourly odds changes · top {markets.length} books</>}
        blurb={<>Which markets move together. Computed on hourly odds CHANGES (not levels), so a
          cell only lights up when two books actually co-move — green together, red opposite.
          Hedgers: a strong green pair is doubled exposure, a strong red pair is a natural hedge.</>}
      />

      {markets.length < 2 || cells.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Not enough overlapping hourly history yet — this fills in as snapshots accumulate
            across the biggest books.
          </p>
          <EdgeFallback />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface p-3">
            <table className="border-collapse">
              <thead>
                <tr>
                  <th></th>
                  {markets.map((m, i) => (
                    <th key={m.id} className="px-0.5 pb-1 align-bottom">
                      <span
                        className="inline-block w-6 -rotate-45 whitespace-nowrap text-left font-mono text-[9px] text-muted"
                        title={m.question}
                      >
                        {i + 1}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {markets.map((row, ri) => (
                  <tr key={row.id}>
                    <td className="max-w-[240px] pr-2">
                      <Link
                        href={`/markets/${encodeURIComponent(row.id)}`}
                        className="flex items-center gap-1.5 text-[11px] text-fg hover:text-white"
                        title={row.question}
                      >
                        <span className="font-mono text-[9px] text-muted">{ri + 1}</span>
                        <span className="truncate">{short(row.question)}</span>
                      </Link>
                    </td>
                    {markets.map((col, ci) => {
                      if (ci === ri) {
                        return <td key={col.id} className="h-6 w-6 bg-track/40 text-center font-mono text-[8px] text-muted">—</td>;
                      }
                      const c = get(row.id, col.id);
                      return (
                        <td
                          key={col.id}
                          className="h-6 w-6 border border-[rgb(var(--c-bg))] text-center"
                          style={{ backgroundColor: c ? cellColor(c.rho) : "rgb(var(--c-track) / 0.25)" }}
                          title={
                            c
                              ? `ρ ${c.rho.toFixed(2)} (${c.points} pts)\n${row.question}\n× ${col.question}`
                              : "insufficient overlap"
                          }
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {strongest.length > 0 && (
            <div>
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                Strongest pairs
              </h2>
              <div className="stagger grid gap-2 lg:grid-cols-2">
                {strongest.map((c) => (
                  <div
                    key={`${c.a}|${c.b}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
                  >
                    <span className="min-w-0 text-[13px] text-fg">
                      <span className="line-clamp-1">{title.get(c.a)}</span>
                      <span className="line-clamp-1 text-muted">× {title.get(c.b)}</span>
                    </span>
                    <span
                      className="shrink-0 rounded px-2 py-1 font-mono text-sm font-semibold tabular-nums"
                      style={{ backgroundColor: cellColor(c.rho), color: "rgb(var(--c-bg))" }}
                    >
                      ρ {c.rho >= 0 ? "+" : ""}
                      {c.rho.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {markets.map((m, i) => (
              <span key={m.id} className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
                {i + 1}. {short(m.question, 40)} <VenueBadge venue={m.venue} />
              </span>
            ))}
          </div>
        </>
      )}

      <p className="max-w-3xl text-xs text-muted">
        Pairs need ≥8 overlapping hourly changes to show at all — faint cells mean insufficient
        overlap, not zero correlation. Correlation is not causation, and 72h of hourly data is a
        short sample; treat |ρ| under ~0.3 as noise.
      </p>
    </div>
  );
}
