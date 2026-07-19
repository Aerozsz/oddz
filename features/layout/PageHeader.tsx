import type { ReactNode } from "react";
import { brand } from "@/lib/brand";

/**
 * The handoff's shared page chrome: slim header — wordmark + "/ PageName"
 * left, a mono-caps contextual element right, bottom border. Replaces the
 * old big H1 + paragraph blocks on every page; explanatory prose moves to
 * footnotes or the optional one-line `blurb`.
 */
export function PageHeader({
  title,
  context,
  blurb,
}: {
  title: string;
  /** Right-aligned live context: a count, a status, a formula. */
  context?: ReactNode;
  /** Optional single quiet line under the chrome. */
  blurb?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <h1 className="flex items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-[-0.03em] text-fg">{brand.wordmark}</span>
          <span className="text-[13px] text-muted">/ {title}</span>
        </h1>
        {context && (
          <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            {context}
          </div>
        )}
      </div>
      {blurb && <p className="max-w-3xl text-[13px] text-muted">{blurb}</p>}
    </div>
  );
}

/** Small live-status dot for `context` slots. */
export function LiveDot() {
  return <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />;
}
