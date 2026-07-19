"use client";

import { useState, useTransition } from "react";
import { createAlert, deleteAlert, resetAlert } from "./actions";
import type { AlertRuleRow } from "./queries";
import { cn, formatPct } from "@/lib/utils";

const KIND_LABEL: Record<AlertRuleRow["kind"], string> = {
  price_above: "YES rises to",
  price_below: "YES falls to",
  move_24h: "moves ≥ (24h)",
};

function describe(rule: AlertRuleRow): string {
  const pct = `${Math.round(rule.threshold * 100)}%`;
  return `${KIND_LABEL[rule.kind]} ${pct}`;
}

function RuleCard({ rule }: { rule: AlertRuleRow }) {
  const [pending, start] = useTransition();
  const fired = rule.triggeredAt !== null;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3 transition-colors",
        fired
          ? "border-[rgb(var(--c-accent))]/50 bg-accent/10"
          : "border-border bg-surface",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-xs text-fg">{rule.question}</span>
        <button
          onClick={() => start(async () => void (await deleteAlert(rule.id)))}
          disabled={pending}
          aria-label="Delete rule"
          className="shrink-0 text-muted transition-colors hover:text-neg"
        >
          ✕
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] tabular-nums text-muted">{describe(rule)}</span>
        {fired ? (
          <span className="flex items-center gap-2">
            <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-bg">
              Hit {rule.triggeredValue !== null ? formatPct(rule.triggeredValue) : ""}
            </span>
            <button
              onClick={() => start(async () => void (await resetAlert(rule.id)))}
              disabled={pending}
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted hover:text-fg"
            >
              Re-arm
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
            Armed
            {rule.currentYes !== null && (
              <span className="tabular-nums text-muted/70">· now {formatPct(rule.currentYes)}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function NewRuleForm({
  markets,
  onDone,
}: {
  markets: { id: string; question: string }[];
  onDone: () => void;
}) {
  const [marketId, setMarketId] = useState(markets[0]?.id ?? "");
  const [kind, setKind] = useState<AlertRuleRow["kind"]>("price_above");
  const [threshold, setThreshold] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await createAlert(marketId, kind, threshold);
          if (!res.ok) setError(res.error ?? "Failed to create rule.");
          else onDone();
        });
      }}
    >
      <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        Market
        <select
          value={marketId}
          onChange={(e) => setMarketId(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 font-sans text-xs normal-case tracking-normal text-fg"
        >
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.question.slice(0, 60)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="flex-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          Condition
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AlertRuleRow["kind"])}
            className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 font-sans text-xs normal-case tracking-normal text-fg"
          >
            <option value="price_above">YES rises to</option>
            <option value="price_below">YES falls to</option>
            <option value="move_24h">24h move exceeds</option>
          </select>
        </label>
        <label className="w-20 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          %
          <input
            type="number"
            min={1}
            max={99}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs tabular-nums text-fg"
          />
        </label>
      </div>
      {error && <p className="text-xs text-neg">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !marketId}
          className="flex-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-transform hover:scale-[1.02] hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? "Saving…" : "Create rule"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AlertPanel({
  rules,
  markets,
}: {
  rules: AlertRuleRow[];
  markets: { id: string; question: string }[];
}) {
  const [adding, setAdding] = useState(false);
  const fired = rules.filter((r) => r.triggeredAt !== null).length;

  return (
    <aside className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        Alert rules
        <span className="text-muted/60">({rules.length})</span>
        {fired > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] font-semibold text-bg">
            {fired} hit
          </span>
        )}
      </h2>
      <div className="stagger flex flex-col gap-2">
        {rules.map((r) => (
          <RuleCard key={r.id} rule={r} />
        ))}
        {adding ? (
          <NewRuleForm markets={markets} onDone={() => setAdding(false)} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            disabled={markets.length === 0}
            className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted transition-colors hover:border-[rgb(var(--c-accent))]/50 hover:text-fg disabled:opacity-50"
          >
            + New rule
          </button>
        )}
        {markets.length === 0 && (
          <p className="text-[11px] text-muted">Star a market to create alert rules for it.</p>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted/80">
        Rules check the latest snapshot when you visit. A hit stays lit until you re-arm it.
      </p>
    </aside>
  );
}
