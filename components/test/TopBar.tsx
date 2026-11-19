"use client";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IconClock } from "@/components/Icons";
import { mmss } from "./useCountdown";
import type { SaveStatus } from "./api";

export function TopBar({ section, name, remaining, save, right }: { section?: string; name?: string; remaining?: number; save?: SaveStatus; right?: React.ReactNode }) {
  const warn = remaining !== undefined && remaining <= 300;
  const caution = remaining !== undefined && remaining <= 600 && !warn;
  return (
    <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4">
        <div className={section ? "hidden sm:block" : ""}><Logo href="/" /></div>
        {section && <span className="chip bg-slate-100 text-ink-soft">{section}</span>}
        <div className="ml-auto flex items-center gap-3">
          {save && save !== "idle" && (
            <span className={`hidden text-xs font-medium md:inline ${save === "error" ? "text-rose-600" : "text-ink-muted"}`} aria-live="polite">
              {save === "saving" ? "Saving…" : save === "saved" ? "All changes saved" : "Offline — answers kept on this device, retrying"}
            </span>
          )}
          {name && <span className="hidden max-w-[14rem] truncate text-sm text-ink-soft lg:inline">{name}</span>}
          {remaining !== undefined && (
            <span role="timer" aria-label={`${Math.ceil(remaining / 60)} minutes remaining`}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold tabular-nums ${warn ? "bg-rose-600 text-white" : caution ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-ink"}`}>
              <IconClock className="h-4 w-4" />{mmss(remaining)}
            </span>
          )}
          {right}
          <ThemeToggle />
        </div>
      </div>
      {remaining !== undefined && (warn || caution) && (
        <p className="sr-only" aria-live="assertive">{warn ? "Five minutes or less remaining." : "Ten minutes remaining."}</p>
      )}
    </header>
  );
}
