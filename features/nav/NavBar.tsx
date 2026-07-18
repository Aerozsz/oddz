"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; hint?: string };

// A few primary links stay flat; the rest group under two menus so the bar
// isn't a 15-item horizontal scroll.
const PRIMARY: Item[] = [
  { href: "/overview", label: "Overview" },
  { href: "/trending", label: "Trending" },
  { href: "/markets", label: "Markets" },
];

const SIGNALS: Item[] = [
  { href: "/arbitrage", label: "Arbitrage", hint: "Lock-in cross-venue edges" },
  { href: "/consensus", label: "Consensus", hint: "Fair value vs each venue" },
  { href: "/divergence", label: "Divergence", hint: "Same event, different price" },
  { href: "/leadlag", label: "Lead / lag", hint: "Who moves first" },
  { href: "/overround", label: "Overround", hint: "Vig & buy-all arbs" },
  { href: "/movers", label: "Movers", hint: "Biggest odds swings" },
];

const DISCOVER: Item[] = [
  { href: "/new", label: "New", hint: "Freshly listed" },
  { href: "/resolving", label: "Resolving", hint: "Closest to settlement" },
  { href: "/activity", label: "Activity", hint: "Volume surges" },
  { href: "/watchlist", label: "Watchlist", hint: "Your starred markets" },
  { href: "/status", label: "Status", hint: "Ingestion health" },
  { href: "/docs", label: "API", hint: "JSON endpoints" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

function Menu({ label, items, pathname }: { label: string; items: Item[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const groupActive = items.some((i) => isActive(pathname, i.href));
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
          groupActive ? "text-fg" : "text-muted hover:text-fg",
        )}
        aria-expanded={open}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="opacity-60">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 w-60 pt-1">
          <div className="pop flex flex-col rounded-lg border border-border bg-surface p-1 shadow-lg shadow-black/20">
            {items.map((i) => {
              const active = isActive(pathname, i.href);
              return (
                <Link
                  key={i.href}
                  href={i.href as never}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-md px-3 py-2 transition-colors",
                    active ? "bg-[rgb(var(--c-surface-hover))]" : "hover:bg-[rgb(var(--c-surface-hover))]",
                  )}
                >
                  <span className={cn("text-[13px]", active ? "text-fg" : "text-fg/90")}>
                    {i.label}
                  </span>
                  {i.hint && <span className="text-[11px] text-muted">{i.hint}</span>}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-1 px-6 py-3">
        <Link href="/" className="mr-2 shrink-0" aria-label="oddz home">
          <Logo size={22} />
        </Link>
        <nav className="flex flex-1 items-center gap-0.5">
          {PRIMARY.map((l) => (
            <Link
              key={l.href}
              href={l.href as never}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                isActive(pathname, l.href) ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              {l.label}
            </Link>
          ))}
          <Menu label="Signals" items={SIGNALS} pathname={pathname} />
          <Menu label="Discover" items={DISCOVER} pathname={pathname} />
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
