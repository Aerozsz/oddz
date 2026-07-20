"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD } from "@/lib/utils";

interface Result {
  id: string;
  question: string;
  venue: string;
  venueName: string;
  category: string | null;
  yes: number | null;
  volume: number | null;
}

/**
 * ⌘K / Ctrl-K command palette — instant market search from anywhere, the
 * defining affordance of a data site. Debounced typeahead against the
 * internal /api/search endpoint; arrow keys + enter to navigate.
 */
export function SearchCommand() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // Global hotkey + "/" to open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (
        e.key === "/" &&
        !open &&
        !/input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "")
      ) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
    else {
      setQ("");
      setResults([]);
      setActive(0);
    }
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results: Result[] }) => {
          if (id === seq.current) {
            setResults(d.results ?? []);
            setActive(0);
          }
        })
        .catch(() => {})
        .finally(() => id === seq.current && setLoading(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  const go = useCallback(
    (r: Result) => {
      setOpen(false);
      router.push(`/markets/${encodeURIComponent(r.id)}` as never);
    },
    [router],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      go(results[active]);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-bg px-3 py-1.5 text-left text-[13px] text-muted transition-colors hover:border-[rgb(var(--c-accent))]/40 hover:text-fg"
      >
        <svg width="13" height="13" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <circle cx="6.5" cy="6.5" r="4.5" />
          <path d="M10 10l3 3" strokeLinecap="round" />
        </svg>
        <span className="flex-1">Search markets…</span>
        <kbd className="rounded border border-border px-1 font-mono text-[10px] text-muted">⌘K</kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="pop w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <svg width="16" height="16" viewBox="0 0 15 15" fill="none" stroke="rgb(var(--c-muted))" strokeWidth="1.4" aria-hidden>
                <circle cx="6.5" cy="6.5" r="4.5" />
                <path d="M10 10l3 3" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search every market across all venues…"
                className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
              />
              {loading && <span className="pulse-dot h-2 w-2 rounded-full bg-accent" />}
              <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
            </div>

            <div className="max-h-[52vh] overflow-y-auto">
              {q.trim().length < 2 ? (
                <p className="p-6 text-center text-xs text-muted">
                  Type at least two characters. ↑↓ to move · ↵ to open.
                </p>
              ) : results.length === 0 && !loading ? (
                <p className="p-6 text-center text-xs text-muted">No markets match “{q}”.</p>
              ) : (
                results.map((r, i) => (
                  <button
                    key={r.id}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      i === active ? "bg-[rgb(var(--c-surface-hover))]" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 text-[13px] text-fg">{r.question}</span>
                      <span className="flex items-center gap-2 pt-0.5">
                        <VenueBadge venue={r.venue} name={r.venueName} />
                        {r.category && <span className="text-[11px] text-muted">{r.category}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {r.yes !== null && (
                        <span className="block font-mono text-sm font-semibold tabular-nums text-fg">
                          {formatPct(r.yes)}
                        </span>
                      )}
                      <span className="block font-mono text-[10px] tabular-nums text-muted">
                        {formatUSD(r.volume)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
