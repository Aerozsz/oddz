"use client";

import type { WireSnapshot } from "@/lib/holders/serialize";
import { cn } from "@/lib/utils";
import { shortAddr, tokens, usd } from "./format";

const DIRECTION_STYLE: Record<string, { label: string; cls: string }> = {
  buy: { label: "BUY", cls: "text-accent" },
  sell: { label: "SELL", cls: "text-neg" },
  mint: { label: "MINT", cls: "text-muted" },
  burn: { label: "BURN", cls: "text-muted" },
  move: { label: "MOVE", cls: "text-muted" },
};

/**
 * The live transfer feed.
 *
 * Rows name the entity rather than the address wherever clustering resolved
 * one, so a wallet moving tokens to its own fresh address reads as an internal
 * move by a known actor instead of as a new holder appearing from nowhere.
 */
export function FlowFeed({ snap }: { snap: WireSnapshot }) {
  const sym = snap.token.symbol;
  // The entity id of the largest holder, so its activity can be marked.
  const topEntity = snap.entities.find((e) => e.kind !== "pair" && e.kind !== "zero")?.id;

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          Live flow
        </h3>
        <span className="font-mono text-[10px] text-muted">{snap.flows.length} events</span>
      </div>
      <ul className="max-h-[520px] divide-y divide-border-subtle/50 overflow-y-auto">
        {snap.flows.map((f) => {
          const style = DIRECTION_STYLE[f.direction] ?? DIRECTION_STYLE.move;
          const actor =
            f.direction === "sell"
              ? (f.fromEntity ?? f.from)
              : f.direction === "buy"
                ? (f.toEntity ?? f.to)
                : (f.fromEntity ?? f.from);
          const isTop = topEntity !== undefined && actor === topEntity;
          return (
            <li
              key={`${f.txHash}-${f.from}-${f.to}-${f.blockNumber}`}
              className={cn("flex items-center gap-2 px-3 py-1.5", isTop && "bg-track/40")}
            >
              <span className={cn("w-9 font-mono text-[10px] font-bold", style.cls)}>
                {style.label}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg">
                {tokens(f.value)}
              </span>
              <span className="w-8 shrink-0 text-[10px] text-muted">{sym}</span>
              <span className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
                {usd(f.valueUsd)}
              </span>
              <span className="flex-1 truncate font-mono text-[10px] text-muted">
                {shortAddr(actor)}
                {isTop && <span className="ml-1 text-accent">top holder</span>}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted">
                {f.blockNumber.toLocaleString()}
              </span>
            </li>
          );
        })}
        {snap.flows.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-muted">
            No transfers in the indexed window yet.
          </li>
        )}
      </ul>
    </div>
  );
}
