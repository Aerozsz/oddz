"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

/**
 * Theme switch: swaps the token set only (data-theme on <html>), persisted
 * to localStorage. The no-flash inline script in layout sets the initial
 * value before paint, so this just reflects/toggles it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
    setTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    // Cross-tint every color for one beat instead of hard-swapping the theme.
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next);
    window.setTimeout(() => root.classList.remove("theme-switching"), 360);
    try {
      localStorage.setItem("oddz-theme", next);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted transition-colors hover:text-fg"
    >
      {theme === "dark" ? (
        // sun
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // moon
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
