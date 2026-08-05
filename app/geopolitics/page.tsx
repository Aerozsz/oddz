import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { geoHealth, signalsWindow, type GeoItem } from "@/features/geo/queries";
import { computeTilt, computeTheaterTilts, tiltLabel } from "@/features/geo/tilt";
import { THEATER_LABEL, type Theater } from "@/lib/geo/types";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Peace ↔ War — Trump market tracker",
  description:
    "Omnisourced, at-a-glance tracker for Trump's market-moving peace-vs-war announcements. Live escalation↔de-escalation tilt, split by theater, both sides side-by-side.",
};

const WINDOW_HOURS = 48;

const INTENSITY_STYLE: Record<GeoItem["intensity"], string> = {
  critical: "border-red-500/50 bg-red-500/15 text-red-300",
  high: "border-amber-500/45 bg-amber-500/12 text-amber-300",
  medium: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  low: "border-zinc-600/50 bg-zinc-700/10 text-zinc-400",
};

const LEAN_LABEL: Record<GeoItem["marketLean"], string> = {
  risk_off: "risk-off",
  risk_on: "risk-on",
  mixed: "mixed",
};

function isTheater(v: string | undefined): v is Theater {
  return v != null && v in THEATER_LABEL;
}

export default async function GeopoliticsPage({
  searchParams,
}: {
  searchParams: Promise<{ theater?: string }>;
}) {
  const sp = await searchParams;
  const active = isTheater(sp.theater) ? sp.theater : null;

  const [all, health] = await Promise.all([signalsWindow(WINDOW_HOURS, 240), geoHealth()]);

  // Theater strip is always computed over everything; the gauge + columns
  // narrow to the selected theater when one is picked.
  const theaterTilts = computeTheaterTilts(all, WINDOW_HOURS);
  const scoped = active ? all.filter((s) => s.theater === active) : all;
  const tilt = computeTilt(scoped, WINDOW_HOURS);

  const escalation = scoped.filter((s) => s.side === "escalation");
  const deescalation = scoped.filter((s) => s.side === "deescalation");
  const mixed = scoped.filter((s) => s.side === "neutral");

  const stale =
    health.lastRunAt != null && Date.now() - new Date(health.lastRunAt).getTime() > 15 * 60_000;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Peace ↔ War"
        context={
          <>
            <LiveDot /> tilt {tilt.value > 0 ? `+${tilt.value}` : tilt.value} · {health.seenToday} today
          </>
        }
        blurb={
          <>
            Trump moves markets with peace-vs-war headlines on a repeatable loop. This tracks both
            sides at a glance: every escalation (risk-off) and de-escalation (risk-on) signal from the
            wires and his own feed, scored and split by theater. The gauge is the current,
            recency-weighted tilt over the last {WINDOW_HOURS}h.
          </>
        }
      />

      <TiltGauge tilt={tilt} scopeLabel={active ? THEATER_LABEL[active] : "All theaters"} />

      {/* Theater strip — switch scope, see each front's lean at once. */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
            Theaters · last {WINDOW_HOURS}h
          </h2>
          {active && (
            <Link href={"/geopolitics" as never} className="font-mono text-[10px] text-accent hover:underline">
              clear filter ✕
            </Link>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(Object.keys(THEATER_LABEL) as Theater[]).map((th) => {
            const t = theaterTilts.find((x) => x.theater === th);
            return (
              <TheaterCard
                key={th}
                theater={th}
                tilt={t?.tilt ?? 0}
                esc={t?.escalationCount ?? 0}
                deesc={t?.deescalationCount ?? 0}
                lastAt={t?.lastAt ?? null}
                active={active === th}
              />
            );
          })}
        </div>
      </section>

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
        <span className="font-mono uppercase tracking-[0.1em]">🔴 escalation = risk-off · 🟢 de-escalation = risk-on</span>
      </div>

      {/* The two sides, side by side. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SideColumn
          title="Escalation"
          mark="🔴"
          accent="rgb(var(--c-neg))"
          items={escalation}
          empty="No escalation headlines in window."
        />
        <SideColumn
          title="De-escalation"
          mark="🟢"
          accent="rgb(var(--c-accent))"
          items={deescalation}
          empty="No de-escalation headlines in window."
        />
      </div>

      {mixed.length > 0 && (
        <section>
          <h2 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
            Mixed / unclear ({mixed.length}) — both signals in one headline
          </h2>
          <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
            {mixed.slice(0, 10).map((it) => (
              <li key={it.id} className="flex items-start gap-2 px-4 py-2.5">
                <span className="mt-0.5 shrink-0 text-zinc-500">◆</span>
                <div className="min-w-0 flex-1">
                  <a href={it.url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-fg hover:text-accent hover:underline">
                    {it.title}
                  </a>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-muted">
                    <span className="font-mono">{THEATER_LABEL[it.theater]}</span>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{it.sourceLabel}</span>
                    <span aria-hidden>·</span>
                    <span>{timeAgo(it.at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="max-w-3xl text-[11px] leading-relaxed text-muted">
        Detection latency is bounded by the cron cadence (~1–5 min); the push is instant. Side and
        theater are inferred from headline text and can misread sarcasm or a mixed message — the
        Mixed lane exists for exactly that. Trade/tariff moves are folded in as an escalation flavor.
        Not investment advice.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TiltGauge({ tilt, scopeLabel }: { tilt: ReturnType<typeof computeTilt>; scopeLabel: string }) {
  // Map −100..+100 onto 0..100% for the pointer.
  const pos = (tilt.value + 100) / 2;
  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            {scopeLabel} · current tilt
          </div>
          <div className="mt-0.5 text-lg font-semibold tracking-tight text-fg">
            {tiltLabel(tilt.value)}{" "}
            <span className="font-mono text-base text-muted">
              ({tilt.value > 0 ? `+${tilt.value}` : tilt.value})
            </span>
          </div>
        </div>
        <div className="text-right font-mono text-[11px] text-muted">
          <span className="text-red-400">🔴 {tilt.escalationCount}</span>
          {"  "}
          <span className="text-emerald-400">🟢 {tilt.deescalationCount}</span>
          {tilt.neutralCount > 0 && <span className="text-zinc-500"> · ◆ {tilt.neutralCount}</span>}
        </div>
      </div>

      {/* Bipolar bar */}
      <div className="relative h-9">
        <div
          className="absolute inset-0 rounded-lg"
          style={{
            background:
              "linear-gradient(90deg, rgba(239,68,68,0.55) 0%, rgba(239,68,68,0.18) 38%, rgba(113,113,122,0.18) 50%, rgba(16,185,129,0.18) 62%, rgba(16,185,129,0.55) 100%)",
          }}
        />
        {/* center tick */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-zinc-500/40" />
        {/* pointer */}
        <div
          className="absolute top-[-4px] flex h-[calc(100%+8px)] w-0 flex-col items-center"
          style={{ left: `${pos}%` }}
        >
          <div className="h-full w-[3px] rounded-full bg-fg shadow-[0_0_0_2px_rgba(0,0,0,0.35)]" />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]">
          <span className="text-red-300">◀ Escalation · risk-off</span>
          <span className="text-emerald-300">De-escalation · risk-on ▶</span>
        </div>
      </div>
    </section>
  );
}

function TheaterCard({
  theater,
  tilt,
  esc,
  deesc,
  lastAt,
  active,
}: {
  theater: Theater;
  tilt: number;
  esc: number;
  deesc: number;
  lastAt: Date | null;
  active: boolean;
}) {
  const pos = (tilt + 100) / 2;
  const total = esc + deesc;
  return (
    <Link
      href={(active ? "/geopolitics" : `/geopolitics?theater=${theater}`) as never}
      className={
        "flex flex-col gap-1.5 rounded-lg border p-2.5 transition-colors " +
        (active
          ? "border-accent/60 bg-[rgb(var(--c-surface-hover))]"
          : "border-border bg-surface hover:border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]")
      }
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[11px] font-medium text-fg">{THEATER_LABEL[theater]}</span>
        <span className="shrink-0 font-mono text-[9px] text-muted">{total || "—"}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-zinc-700/40">
        {total > 0 && (
          <span
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${pos}%`,
              backgroundColor:
                tilt < -15 ? "rgb(var(--c-neg))" : tilt > 15 ? "rgb(var(--c-accent))" : "rgb(161,161,170)",
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between font-mono text-[9px]">
        <span className="text-red-400">🔴{esc}</span>
        <span className="text-zinc-500">{lastAt ? timeAgo(lastAt) : ""}</span>
        <span className="text-emerald-400">🟢{deesc}</span>
      </div>
    </Link>
  );
}

function SideColumn({
  title,
  mark,
  accent,
  items,
  empty,
}: {
  title: string;
  mark: string;
  accent: string;
  items: GeoItem[];
  empty: string;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <span>{mark}</span>
          {title}
        </h2>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
          style={{ backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
        >
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-muted">{empty}</div>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {items.map((it) => (
            <li key={it.id} className="flex flex-col gap-1 px-4 py-3">
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[14px] font-medium leading-snug text-fg hover:text-accent hover:underline"
              >
                {it.title}
              </a>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className={`rounded border px-1.5 py-0.5 font-mono uppercase tracking-wide ${INTENSITY_STYLE[it.intensity]}`}>
                  {it.intensity}
                </span>
                <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  {THEATER_LABEL[it.theater]}
                </span>
                {it.notifiedAt && (
                  <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-accent">
                    pushed
                  </span>
                )}
                <span className="font-mono">{it.sourceLabel}</span>
                <span aria-hidden>·</span>
                <span className="font-mono">{LEAN_LABEL[it.marketLean]}</span>
                <span aria-hidden>·</span>
                <span title={new Date(it.at).toISOString()}>{timeAgo(it.at)}</span>
              </div>
              {it.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {it.tags.map((t) => (
                    <span key={t} className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
