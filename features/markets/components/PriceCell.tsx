import { formatPct } from "@/lib/utils";

export function PriceCell({ outcomes, prices }: { outcomes: string[]; prices: number[] }) {
  if (prices.length === 0) return <span className="text-zinc-500">—</span>;

  // Binary YES/NO: show one chip with the YES probability.
  if (outcomes.length === 2 && /yes/i.test(outcomes[0])) {
    return <span className="font-mono text-emerald-300">{formatPct(prices[0])}</span>;
  }

  // Multi-outcome: show top 3 by price.
  const ranked = outcomes
    .map((o, i) => ({ o, p: prices[i] ?? 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {ranked.map(({ o, p }) => (
        <div key={o} className="flex items-center justify-between gap-2">
          <span className="truncate text-zinc-300" title={o}>
            {o}
          </span>
          <span className="font-mono text-emerald-300">{formatPct(p)}</span>
        </div>
      ))}
    </div>
  );
}
