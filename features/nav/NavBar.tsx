"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/markets", label: "Markets" },
  { href: "/arbitrage", label: "Arbitrage" },
  { href: "/divergence", label: "Divergence" },
  { href: "/movers", label: "Movers" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/status", label: "Status" },
  { href: "/docs", label: "API" },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
          <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
            {brand.wordmark}
          </span>
        </Link>
        <nav className="-mx-1 flex flex-1 items-center gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href as never}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 transition-colors",
                  active
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
