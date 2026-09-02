"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { SearchCommand } from "@/features/search/SearchCommand";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; badge?: number };
type Section = { label: string | null; items: Item[] };

// DefiLlama-style sidebar: everything visible, grouped, one click away.
const SECTIONS: Section[] = [
  {
    label: null,
    items: [
      { href: "/overview", label: "Overview" },
      { href: "/markets", label: "Markets" },
      { href: "/trending", label: "Trending" },
      { href: "/venues", label: "Venues" },
    ],
  },
  {
    // Only pages that always carry data live in the nav. The matcher-
    // dependent signals (consensus, divergence, lead/lag, correlations)
    // surface through /signals the moment they produce rows.
    label: "Signals",
    items: [
      { href: "/signals", label: "All signals" },
      { href: "/arbitrage", label: "Arbitrage" },
      { href: "/yields", label: "Yields" },
      { href: "/overround", label: "Overround" },
      { href: "/movers", label: "Movers" },
      { href: "/whales", label: "Whales" },
      // /sweep is deliberately absent. The liquidity monitor is unlisted and
      // reached by direct URL only; it still renders normally if you go there.
    ],
  },
  {
    label: "Discover",
    items: [
      { href: "/discover", label: "Discover" },
      { href: "/calendar", label: "Calendar" },
      { href: "/watchlist", label: "Watchlist" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/status", label: "Status" },
      { href: "/docs", label: "API" },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

function NavList({
  pathname,
  alertsFired,
  onNavigate,
}: {
  pathname: string;
  alertsFired: number;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-5">
      {SECTIONS.map((s, si) => (
        <div key={si} className="flex flex-col gap-0.5">
          {s.label && (
            <div className="mb-1 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              {s.label}
            </div>
          )}
          {s.items.map((i) => {
            const active = isActive(pathname, i.href);
            const badge = i.href === "/watchlist" ? alertsFired : 0;
            return (
              <Link
                key={i.href}
                href={i.href as never}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors",
                  active
                    ? "bg-[rgb(var(--c-surface-hover))] text-fg"
                    : "text-muted hover:bg-[rgb(var(--c-surface-hover))] hover:text-fg",
                )}
              >
                {/* active cursor bar */}
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
                )}
                {i.label}
                {badge > 0 && (
                  <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] font-semibold leading-none text-bg">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function SideNav() {
  const pathname = usePathname();
  const [alertsFired, setAlertsFired] = useState(0);
  const [drawer, setDrawer] = useState(false);

  // Personal fired-alert count; refetch on route change so it clears after re-arming.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/alerts/summary")
      .then((r) => (r.ok ? r.json() : { fired: 0 }))
      .then((d: { fired?: number }) => {
        if (!cancelled) setAlertsFired(d.fired ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface/40 px-3 py-4 lg:flex">
        <Link href="/" aria-label="oddz home" className="px-3">
          <Logo size={22} />
        </Link>
        <div className="px-1">
          <SearchCommand />
        </div>
        <NavList pathname={pathname} alertsFired={alertsFired} />
        <div className="mt-auto px-3">
          <ThemeToggle />
        </div>
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-bg/85 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/" aria-label="oddz home">
          <Logo size={20} />
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={() => setDrawer((d) => !d)}
            aria-label={drawer ? "Close menu" : "Open menu"}
            aria-expanded={drawer}
            className="relative flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted hover:text-fg"
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              {drawer ? (
                <path d="M3 3l9 9M12 3l-9 9" />
              ) : (
                <path d="M2 4h11M2 7.5h11M2 11h11" />
              )}
            </svg>
            {alertsFired > 0 && !drawer && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
            )}
          </button>
        </div>
      </div>
      {drawer && (
        <div className="pop fixed inset-x-0 top-[57px] z-40 max-h-[calc(100vh-57px)] overflow-y-auto border-b border-border bg-bg p-4 lg:hidden">
          <div className="mb-4">
            <SearchCommand />
          </div>
          <NavList pathname={pathname} alertsFired={alertsFired} onNavigate={() => setDrawer(false)} />
        </div>
      )}
    </>
  );
}
