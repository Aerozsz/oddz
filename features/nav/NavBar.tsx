"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/trending", label: "Trending" },
  { href: "/markets", label: "Markets" },
  { href: "/new", label: "New" },
  { href: "/resolving", label: "Resolving" },
  { href: "/arbitrage", label: "Arbitrage" },
  { href: "/consensus", label: "Consensus" },
  { href: "/leadlag", label: "Lead/lag" },
  { href: "/overround", label: "Overround" },
  { href: "/divergence", label: "Divergence" },
  { href: "/movers", label: "Movers" },
  { href: "/activity", label: "Activity" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/status", label: "Status" },
  { href: "/docs", label: "API" },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <Link href="/" className="shrink-0" aria-label="oddz home">
          <Logo size={22} />
        </Link>
        <nav className="-mx-1 flex flex-1 items-center gap-0.5 overflow-x-auto px-1 text-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href as never}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 transition-colors",
                  active ? "text-fg" : "text-muted hover:text-fg",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
