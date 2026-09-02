"use client";

import { useState } from "react";
import type { WireEntity, WireSnapshot } from "@/lib/holders/serialize";
import { cn } from "@/lib/utils";
import {
  ACQUISITION_LABEL,
  EVIDENCE_LABEL,
  pct,
  shortAddr,
  signed,
  tokens,
  toneFor,
  usd,
} from "./format";

/**
 * The ranked table.
 *
 * Rows are entities, not addresses. A position split across six wallets is one
 * seller, and showing it as six holders would understate exactly the thing
 * this table exists to measure — so the clustering is applied before ranking,
 * and the constituent addresses live behind a disclosure on the row.
 */
export function WhaleTable({ snap }: { snap: WireSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  const sym = snap.token.symbol;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[1080px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <th className="px-3 py-2.5 font-normal">#</th>
            <th className="px-3 py-2.5 font-normal">Entity</th>
            <th className="px-3 py-2.5 text-right font-normal">Balance</th>
            <th className="px-3 py-2.5 text-right font-normal">Float</th>
            <th className="px-3 py-2.5 text-right font-normal">Δ</th>
            <th className="px-3 py-2.5 text-right font-normal">Paper</th>
            <th className="px-3 py-2.5 text-right font-normal" title="What the pool would actually pay for the whole position">
              Exit
            </th>
            <th className="px-3 py-2.5 text-right font-normal" title="Price impact of exiting the whole position">
              Impact
            </th>
            <th className="px-3 py-2.5 text-right font-normal">Buys / Sells</th>
            <th className="px-3 py-2.5 text-right font-normal" title="Share of everything acquired that has already left">
              Distributed
            </th>
            <th className="px-3 py-2.5 text-right font-normal">Unrealized</th>
            <th className="px-3 py-2.5 font-normal">Source</th>
          </tr>
        </thead>
        <tbody>
          {snap.entities.map((e) => (
            <Row
              key={e.id}
              e={e}
              sym={sym}
              open={open === e.id}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
            />
          ))}
          {snap.entities.length === 0 && (
            <tr>
              <td colSpan={12} className="px-3 py-8 text-center text-muted">
                No holders indexed yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  e,
  sym,
  open,
  onToggle,
}: {
  e: WireEntity;
  sym: string;
  open: boolean;
  onToggle: () => void;
}) {
  const clustered = e.addressCount > 1;
  const rankMove = e.prevRank !== null ? e.prevRank - e.rank : 0;
  const isPool = e.kind === "pair";
  const isBurn = e.kind === "zero";

  return (
    <>
      <tr
        onClick={clustered || e.evidence.length > 0 ? onToggle : undefined}
        className={cn(
          "border-b border-border-subtle/60 transition-colors",
          (clustered || e.evidence.length > 0) && "cursor-pointer hover:bg-track/40",
          (isPool || isBurn) && "text-muted",
        )}
      >
        <td className="px-3 py-2.5 font-mono text-[11px] text-muted">
          {e.rank}
          {rankMove !== 0 && (
            <span className={cn("ml-1", rankMove > 0 ? "text-accent" : "text-neg")}>
              {rankMove > 0 ? "↑" : "↓"}
            </span>
          )}
        </td>

        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-fg">{shortAddr(e.id)}</span>
            {e.label && <Tag tone="muted">{e.label}</Tag>}
            {clustered && (
              <Tag tone="accent" title={`${e.addressCount} addresses resolved to one actor`}>
                +{e.addressCount - 1} addr
              </Tag>
            )}
            {e.viaRelayer && (
              <Tag tone="warn" title="Moved tokens through a shared relayer">
                relayed
              </Tag>
            )}
            {e.kind === "contract" && !e.label && <Tag tone="muted">contract</Tag>}
          </div>
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg">
          {tokens(e.balance)}
          <span className="ml-1 text-[10px] text-muted">{sym}</span>
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
          {isPool || isBurn ? <span className="text-muted">—</span> : pct(e.share)}
        </td>

        <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", toneFor(e.delta))}>
          {signed(e.delta, tokens)}
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted">
          {usd(e.valueUsd)}
        </td>

        {/* The gap between these two columns is the whole point of the table. */}
        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-fg">
          {usd(e.realizableUsd)}
          {e.recovery !== null && e.recovery < 0.9 && (
            <span className="ml-1 text-[10px] text-neg">{pct(e.recovery, 0)}</span>
          )}
        </td>

        <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", toneFor(e.exitImpact))}>
          {pct(e.exitImpact, 0)}
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[12px]">
          <span className="text-accent">{e.behavior.buyCount}</span>
          <span className="mx-1 text-muted">/</span>
          <span className="text-neg">{e.behavior.sellCount}</span>
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
          {e.behavior.distributionRatio > 0 ? (
            <span className={e.behavior.distributionRatio > 0.5 ? "text-neg" : "text-fg"}>
              {pct(e.behavior.distributionRatio, 0)}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>

        <td
          className={cn(
            "px-3 py-2.5 text-right font-mono tabular-nums",
            toneFor(e.behavior.unrealizedPnlUsd),
          )}
        >
          {usd(e.behavior.unrealizedPnlUsd)}
        </td>

        <td className="px-3 py-2.5">
          <Tag tone={e.behavior.acquisition === "farmed" ? "warn" : "muted"}>
            {ACQUISITION_LABEL[e.behavior.acquisition]}
          </Tag>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-border-subtle/60 bg-bg/40">
          <td colSpan={12} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  Addresses ({e.addressCount})
                </h4>
                <ul className="flex flex-col gap-1">
                  {e.addresses.map((a) => (
                    <li key={a} className="font-mono text-[11px] text-fg-dim">
                      {a}
                      {a === e.id && <span className="ml-2 text-[10px] text-muted">primary</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  Why these are one actor
                </h4>
                {e.evidence.length === 0 ? (
                  <p className="text-[11px] text-muted">
                    Single address — nothing inferred.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {e.evidence.map((ev, i) => (
                      <li key={i} className="text-[11px] text-fg-dim">
                        <span className="font-mono text-muted">
                          [{EVIDENCE_LABEL[ev.kind] ?? ev.kind}]
                        </span>{" "}
                        {ev.detail}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[10px] text-muted">
                  Confidence {pct(e.confidence, 0)} · first seen block{" "}
                  {e.firstSeenBlock.toLocaleString()} · {e.transferCount} transfers
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Tag({
  children,
  tone = "muted",
  title,
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "warn";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "warn" && "bg-neg/15 text-neg",
        tone === "muted" && "bg-track text-muted",
      )}
    >
      {children}
    </span>
  );
}
