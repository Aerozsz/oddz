import type { Config } from "tailwindcss";

// Colours are CSS variables (see app/theme.css) so light and dark themes share every class.
export default {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "slate": {
          "50": "rgb(var(--c-slate-50) / <alpha-value>)",
          "100": "rgb(var(--c-slate-100) / <alpha-value>)",
          "200": "rgb(var(--c-slate-200) / <alpha-value>)",
          "300": "rgb(var(--c-slate-300) / <alpha-value>)",
          "400": "rgb(var(--c-slate-400) / <alpha-value>)"
        },
        "brand": {
          "50": "rgb(var(--c-brand-50) / <alpha-value>)",
          "100": "rgb(var(--c-brand-100) / <alpha-value>)",
          "200": "rgb(var(--c-brand-200) / <alpha-value>)",
          "300": "rgb(var(--c-brand-300) / <alpha-value>)",
          "400": "rgb(var(--c-brand-400) / <alpha-value>)",
          "500": "rgb(var(--c-brand-500) / <alpha-value>)",
          "600": "rgb(var(--c-brand-600) / <alpha-value>)",
          "700": "rgb(var(--c-brand-700) / <alpha-value>)",
          "800": "rgb(var(--c-brand-800) / <alpha-value>)",
          "900": "rgb(var(--c-brand-900) / <alpha-value>)",
          "950": "rgb(var(--c-brand-950) / <alpha-value>)"
        },
        "emerald": {
          "50": "rgb(var(--c-emerald-50) / <alpha-value>)",
          "100": "rgb(var(--c-emerald-100) / <alpha-value>)",
          "200": "rgb(var(--c-emerald-200) / <alpha-value>)",
          "500": "rgb(var(--c-emerald-500) / <alpha-value>)",
          "700": "rgb(var(--c-emerald-700) / <alpha-value>)",
          "800": "rgb(var(--c-emerald-800) / <alpha-value>)"
        },
        "amber": {
          "50": "rgb(var(--c-amber-50) / <alpha-value>)",
          "100": "rgb(var(--c-amber-100) / <alpha-value>)",
          "200": "rgb(var(--c-amber-200) / <alpha-value>)",
          "700": "rgb(var(--c-amber-700) / <alpha-value>)",
          "800": "rgb(var(--c-amber-800) / <alpha-value>)",
          "900": "rgb(var(--c-amber-900) / <alpha-value>)"
        },
        "rose": {
          "50": "rgb(var(--c-rose-50) / <alpha-value>)",
          "100": "rgb(var(--c-rose-100) / <alpha-value>)",
          "200": "rgb(var(--c-rose-200) / <alpha-value>)",
          "500": "rgb(var(--c-rose-500) / <alpha-value>)",
          "600": "rgb(var(--c-rose-600) / <alpha-value>)",
          "700": "rgb(var(--c-rose-700) / <alpha-value>)",
          "800": "rgb(var(--c-rose-800) / <alpha-value>)"
        },
        "surface": "rgb(var(--c-surface) / <alpha-value>)",
        "contrast": "rgb(var(--c-contrast) / <alpha-value>)",
        "ink": {
          "DEFAULT": "rgb(var(--c-ink) / <alpha-value>)",
          "soft": "rgb(var(--c-ink-soft) / <alpha-value>)",
          "muted": "rgb(var(--c-ink-muted) / <alpha-value>)"
        },
        "series": {
          "1": "rgb(var(--c-series-1) / <alpha-value>)",
          "2": "rgb(var(--c-series-2) / <alpha-value>)",
          "3": "rgb(var(--c-series-3) / <alpha-value>)",
          "4": "rgb(var(--c-series-4) / <alpha-value>)"
        },
        "status": {
          "bad": "rgb(var(--c-bad) / <alpha-value>)",
          "warn": "rgb(var(--c-warn) / <alpha-value>)",
          "good": "rgb(var(--c-good) / <alpha-value>)"
        }
      },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"], serif: ["var(--font-serif)", "Georgia", "serif"] },
      boxShadow: { card: "0 1px 2px rgb(15 23 42 / .04), 0 4px 16px rgb(15 23 42 / .06)" },
    },
  },
  plugins: [],
} satisfies Config;
