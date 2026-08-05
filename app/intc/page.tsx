import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { monitorHealth, recentCatalysts, type FeedItem } from "@/features/intc/queries";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "INTC foundry monitor",
  description:
    "Real-time watch for the foundry catalysts that actually reprice $INTC — 18A/14A customer wins, capex, foundry P&L, separation — pushed the moment they land.",
};

const SEV_STYLE: Record<FeedItem["severity"], string> = {
  critical: "border-red-500/50 bg-red-500/15 text-red-300",
  high: "border-amber-500/45 bg-amber-500/12 text-amber-300",
  medium: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  low: "border-zinc-600/50 bg-zinc-700/10 text-zinc-400",
};

const DIR_MARK: Record<FeedItem["direction"], { mark: string; cls: string; label: string }> = {
  bullish: { mark: "▲", cls: "text-emerald-400", label: "bullish" },
  bearish: { mark: "▼", cls: "text-red-400", label: "bearish" },
  neutral: { mark: "◆", cls: "text-zinc-400", label: "neutral" },
};

export default async function IntcPage() {
  const [items, health] = await Promise.all([recentCatalysts(60), monitorHealth()]);

  const stale =
    health.lastRunAt != null && Date.now() - new Date(health.lastRunAt).getTime() > 15 * 60_000;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="INTC foundry"
        context={
          <>
            <LiveDot /> {health.pushedToday} pushed · {health.seenToday} seen · 24h
          </>
        }
        blurb={
          <>
            Intel no longer trades off quarterly results — it trades off the foundry. This watches the
            catalysts that actually reprice $INTC (a named 18A/14A external customer, capex, foundry
            P&amp;L, separation) across news wires, Intel&apos;s newsroom, and SEC filings, and pushes
            the moment one lands. Threshold and channels are operator-configured.
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span
          className={
            "inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono " +
            (stale
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300")
          }
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: stale ? "rgb(var(--c-neg))" : "rgb(var(--c-accent))" }}
          />
          {health.lastRunAt ? `monitor ran ${timeAgo(health.lastRunAt)}` : "monitor idle"}
          {stale && " — check the cron"}
        </span>
        <span className="font-mono uppercase tracking-[0.1em]">
          ▲ bullish · ▼ bearish · ◆ mixed
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No foundry catalysts recorded yet. The monitor runs on the{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">intc-monitor</code> schedule; a
          quiet feed means nothing material has crossed the wire since it started. Trigger a run
          locally with{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">npm run intc:once</code>.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
          {items.map((it) => {
            const dir = DIR_MARK[it.direction];
            return (
              <li key={it.id} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 shrink-0 font-mono text-sm ${dir.cls}`} title={dir.label}>
                    {dir.mark}
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[14px] font-medium text-fg hover:text-accent hover:underline"
                    >
                      {it.title}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono uppercase tracking-wide ${SEV_STYLE[it.severity]}`}
                      >
                        {it.severity}
                      </span>
                      {it.notifiedAt && (
                        <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-accent">
                          pushed
                        </span>
                      )}
                      <span className="font-mono">{it.sourceLabel}</span>
                      <span aria-hidden>·</span>
                      <span className="font-mono">score {it.score}</span>
                      <span aria-hidden>·</span>
                      <span title={new Date(it.publishedAt ?? it.firstSeenAt).toISOString()}>
                        {timeAgo(it.publishedAt ?? it.firstSeenAt)}
                      </span>
                    </div>
                    {it.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {it.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-400"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="max-w-3xl text-[11px] leading-relaxed text-muted">
        Detection latency is bounded by the cron cadence (~1–5 min on GitHub&apos;s scheduler); the
        push itself is instant. Not investment advice — a screening tool for catalysts, not a
        recommendation to trade.
      </p>
    </div>
  );
}
