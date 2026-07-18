import Link from "next/link";
import type { CategoryStat, FeaturedMarket } from "./queries";
import { cn, formatPct, formatUSD } from "@/lib/utils";

const LABEL = "font-mono text-[10px] uppercase tracking-[0.14em] text-muted";

export function StatCard({
  label,
  value,
  change,
  href,
}: {
  label: string;
  value: string;
  change?: { text: string; up: boolean };
  href?: string;
}) {
  const inner = (
    <div className="lift flex flex-col gap-1 rounded-lg border border-border bg-surface p-[14px_16px]">
      <div className={LABEL}>{label}</div>
      <div className="font-mono text-xl font-semibold text-fg">{value}</div>
      {change && (
        <div className={cn("font-mono text-[11px]", change.up ? "text-accent" : "text-neg")}>
          {change.up ? "▲" : "▼"} {change.text}
        </div>
      )}
    </div>
  );
  return href ? <Link href={href as never}>{inner}</Link> : inner;
}

/** Volume-by-category horizontal bars (accent fill, opacity decreasing by rank). */
export function CategoryBars({ categories }: { categories: CategoryStat[] }) {
  const top = categories.slice(0, 6);
  const max = Math.max(...top.map((c) => c.volume), 1);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-[18px]">
      <span className={LABEL}>Volume by category</span>
      {top.length === 0 && <span className="text-xs text-muted">No category data yet.</span>}
      {top.map((c, i) => (
        <Link
          key={c.category}
          href={`/categories/${encodeURIComponent(c.category)}`}
          className="flex items-center gap-2.5"
        >
          <span className="w-[76px] truncate text-[13px] capitalize text-fg">{c.category}</span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-track">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(c.volume / max) * 100}%`, opacity: 1 - i * 0.12 }}
            />
          </span>
          <span className="w-11 text-right font-mono text-[11px] text-muted">
            {formatUSD(c.volume)}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function TradersCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-[18px]">
      <span className={LABEL}>Top traders · 7D PnL</span>
      <div className="flex flex-1 flex-col items-start justify-center gap-1.5 py-4">
        <p className="text-[13px] text-fg">Trader leaderboard is coming.</p>
        <p className="text-xs text-muted">
          Polymarket positions are onchain — this fills in once wallet PnL indexing ships.
        </p>
      </div>
    </div>
  );
}

export function MarketDetailCard({ market }: { market: FeaturedMarket | null }) {
  if (!market) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-[18px]">
        <span className={LABEL}>Market detail</span>
        <span className="text-xs text-muted">No featured market yet.</span>
      </div>
    );
  }
  const yesPct = Math.round(market.yes * 100);
  const noPct = 100 - yesPct;
  const short = market.question.length > 30 ? market.question.slice(0, 29) + "…" : market.question;
  return (
    <Link
      href={`/markets/${encodeURIComponent(market.id)}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-[18px]"
    >
      <span className={cn(LABEL, "truncate")}>Market detail · {short}</span>
      <span className="flex items-baseline gap-2.5">
        <span className="font-mono text-[26px] font-semibold text-accent">{formatPct(market.yes)}</span>
        <span className="truncate text-[13px] text-muted">chance · {market.venueName}</span>
      </span>
      <span className="flex h-2 overflow-hidden rounded-full">
        <span className="bg-accent" style={{ width: `${yesPct}%` }} />
        <span className="bg-neg" style={{ width: `${noPct}%` }} />
      </span>
      <span className="flex justify-between font-mono text-[11px]">
        <span className="text-accent">YES {yesPct}¢</span>
        <span className="text-neg">NO {noPct}¢</span>
      </span>
    </Link>
  );
}
