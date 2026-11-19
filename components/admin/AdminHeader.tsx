import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

export function AdminHeader() {
  return (
    <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Logo href="/admin" />
        <span className="chip bg-slate-100 text-ink-soft">Teacher</span>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link href="/admin" className="btn-ghost">Students</Link>
          <Link href="/" className="btn-ghost hidden sm:inline-flex" target="_blank">Student site ↗</Link>
          <form action="/api/admin/logout" method="post"><button className="btn-ghost">Sign out</button></form>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
