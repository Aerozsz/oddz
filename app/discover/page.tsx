import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import {
  listNewMarkets,
  listResolvingSoon,
  listUnusualActivity,
} from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Discover",
  description: "New listings, markets resolving soon, and volume surges — one screen.",
};

function Column({
  label,
  href,
  children,
}: {
  label: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</h2>
        <Link href={href as never} className="link font-mono text-[11px] text-accent">
          all →
        </Link>
      </div>
      <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

function Row({
  href,
  question,
  venue,
  right,
  sub,
}: {
  href: string;
  question: string;
  venue: string;
  right: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Link href={href as never} className="tap flex flex-col gap-1 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]">
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-[13px] leading-snug text-fg">{question}</span>
        <span className="shrink-0 text-right">{right}</span>
      </div>
      <div className="flex items-center gap-2">
        <VenueBadge venue={venue} />
        {sub}
      </div>
    </Link>
  );
}

export default async function DiscoverPage() {
  const [fresh, resolving, surges] = await Promise.all([
    listNewMarkets(8).catch(() => []),
    listResolvingSoon(8).catch(() => []),
    listUnusualActivity(24, 8).catch(() => []),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Discover"
        context={<><LiveDot /> one screen, zero digging</>}
        blurb={<>The three feeds that matter for finding a trade, side by side: what just listed,
          what settles next, and where money is suddenly moving.</>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Column label="Just listed" href="/new">
          {fresh.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">Nothing new yet.</div>
          ) : (
            fresh.map((r) => (
              <Row
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                question={r.question}
                venue={r.venue}
                right={
                  r.prices?.[0] !== undefined && (
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatPct(r.prices[0])}
                    </span>
                  )
                }
                sub={
                  <span className="font-mono text-[10px] text-muted">
                    {r.createdAt ? timeAgo(r.createdAt) : ""}
                  </span>
                }
              />
            ))
          )}
        </Column>

        <Column label="Resolving next" href="/resolving">
          {resolving.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">Nothing scheduled.</div>
          ) : (
            resolving.map((r) => (
              <Row
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                question={r.question}
                venue={r.venue}
                right={
                  r.prices?.[0] !== undefined && (
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatPct(r.prices[0])}
                    </span>
                  )
                }
                sub={
                  r.endsAt && (
                    <span className="font-mono text-[10px] text-neg">
                      {new Date(r.endsAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                  )
                }
              />
            ))
          )}
        </Column>

        <Column label="Money moving" href="/activity">
          {surges.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">No surges in 24h.</div>
          ) : (
            surges.map((r) => (
              <Row
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                question={r.question}
                venue={r.venue}
                right={
                  <span className="font-mono text-sm font-semibold tabular-nums text-accent">
                    +{formatUSD(r.delta)}
                  </span>
                }
                sub={
                  <span className="font-mono text-[10px] text-muted">
                    {Number.isFinite(r.ratio) ? `${r.ratio.toFixed(1)}× vol` : "new money"}
                  </span>
                }
              />
            ))
          )}
        </Column>
      </div>
    </div>
  );
}
