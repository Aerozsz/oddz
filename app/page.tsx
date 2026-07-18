import Link from "next/link";
import { listArbitrage } from "@/features/arbitrage/queries";
import { listMovers } from "@/features/markets/queries";
import { getOverview } from "@/features/overview/queries";
import { SubscribeForm } from "@/features/subscribe/SubscribeForm";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { brand } from "@/lib/brand";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export default async function HomePage() {
  const [overview, arbs, movers] = await Promise.all([
    getOverview().catch(() => null),
    listArbitrage(0.005, 5).catch(() => []),
    listMovers(24, 6).catch(() => []),
  ]);
  const hasData = (overview?.totalMarkets ?? 0) > 0;

  return (
    <div className="flex flex-col gap-8 py-4">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 sm:p-8">
        {/* The Currents, as ambience: oversized offset beams fading through the card */}
        <svg
          className="pointer-events-none absolute -right-16 top-1/2 hidden h-56 w-[420px] -translate-y-1/2 opacity-[0.16] sm:block"
          viewBox="0 0 48 48"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <linearGradient id="hero-y" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgb(var(--c-accent))" />
              <stop offset="1" stopColor="rgb(var(--c-accent))" stopOpacity="0.05" />
            </linearGradient>
            <linearGradient id="hero-n" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0" stopColor="rgb(var(--c-neg))" />
              <stop offset="1" stopColor="rgb(var(--c-neg))" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <rect x="3" y="13" width="38" height="9" rx="4.5" fill="url(#hero-y)" />
          <rect x="7" y="26" width="38" height="9" rx="4.5" fill="url(#hero-n)" />
        </svg>
        <div className="relative flex flex-col gap-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Polymarket · Kalshi · Manifold · Metaculus
          </span>
          <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Every prediction market. One screen.
          </h1>
          <p className="max-w-xl text-zinc-400">
            Live odds, cross-venue arbitrage, and where the smart money is moving — before the
            crowd reacts.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Link
              href="/markets"
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-bg transition-transform hover:scale-[1.03] hover:bg-accent-hover"
            >
              Browse markets
            </Link>
            <Link
              href="/arbitrage"
              className="rounded-full border border-border px-5 py-2 text-sm text-fg-dim transition-colors hover:border-[rgb(var(--c-accent))]/50 hover:text-fg"
            >
              Live signals →
            </Link>
          </div>
        </div>
      </section>

      {hasData && overview && (
        <section className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total volume" value={formatUSD(overview.totalVolume)} href="/overview" />
          <Stat
            label="Live markets"
            value={overview.totalMarkets.toLocaleString()}
            href="/markets"
          />
          <Stat label="Live arbitrage" value={String(arbs.length)} href="/arbitrage" />
          <Stat label="Venues" value={String(overview.venues.length)} href="/overview" />
        </section>
      )}

      {arbs.length > 0 && (
        <Panel title="Top arbitrage" href="/arbitrage" cta="All arbs →">
          <div className="flex flex-col divide-y divide-zinc-800">
            {arbs.map((a) => (
              <Link
                key={a.eventId}
                href={`/events/${encodeURIComponent(a.eventId)}`}
                className="flex items-center justify-between gap-3 py-2 hover:text-white"
              >
                <span className="line-clamp-1 text-sm text-zinc-200">{a.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <VenueBadge venue={a.buyYes.venue} />
                  <span className="text-zinc-600">/</span>
                  <VenueBadge venue={a.buyNo.venue} />
                  <span className="ml-1 font-mono font-semibold text-emerald-300">
                    +{formatPct(a.edge)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Panel>
      )}

      {movers.length > 0 && (
        <Panel title="Biggest movers (24h)" href="/movers" cta="All movers →">
          <div className="flex flex-col divide-y divide-zinc-800">
            {movers.map((m) => (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent(m.id)}`}
                className="flex items-center justify-between gap-3 py-2 hover:text-white"
              >
                <span className="line-clamp-1 text-sm text-zinc-200">{m.question}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <VenueBadge venue={m.venue} />
                  <span className="font-mono tabular-nums text-muted">
                    {formatPct(m.yesThen)} → {formatPct(m.yesNow)}
                  </span>
                  <span
                    className={cn(
                      "font-mono font-semibold tabular-nums",
                      m.delta >= 0 ? "text-emerald-300" : "text-red-300",
                    )}
                  >
                    {m.delta >= 0 ? "+" : ""}
                    {(m.delta * 100).toFixed(1)}pp
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Panel>
      )}

      {!hasData && (
        <section className="stagger grid gap-6 sm:grid-cols-3">
          <Card title="Aggregated">Every live market across four venues, one search box.</Card>
          <Card title="Arbitrage">Same event, mispriced across venues — lock the spread.</Card>
          <Card title="History">Every snapshot stored. Odds drift, fully queryable. Public API.</Card>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold tracking-tight">Markets-to-watch digest</h2>
        <p className="max-w-2xl text-sm text-zinc-400">
          The biggest moves, arbs, and new markets in your inbox before the crowd reacts. Free in
          beta.
        </p>
        <SubscribeForm />
      </section>

      <p className="text-center text-xs text-zinc-600">
        {brand.name} aggregates public prediction-market data. Not financial advice.
      </p>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link
      href={href as never}
      className="lift rounded-lg border border-border bg-surface p-3"
    >
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
    </Link>
  );
}

function Panel({
  title,
  href,
  cta,
  children,
}: {
  title: string;
  href: string;
  cta: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">{title}</h2>
        <Link href={href as never} className="text-xs text-emerald-400 hover:text-emerald-300">
          {cta}
        </Link>
      </div>
      <div className="rounded-lg border border-border bg-surface px-4 py-1">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-2 text-sm font-medium text-zinc-200">{title}</h3>
      <p className="text-sm text-zinc-400">{children}</p>
    </div>
  );
}
