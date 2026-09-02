import type { Config } from "tailwindcss";

/**
 * Colors are CSS-variable-backed (RGB channel triples in globals.css) so
 * every existing zinc/emerald/red class reskins to the Oddz brand tokens
 * AND flips with the light/dark theme — no per-page edits. New code should
 * prefer the semantic names (bg, surface, border, fg, muted, accent, neg).
 */
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./features/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // Semantic brand tokens
        bg: v("--c-bg"),
        surface: v("--c-surface"),
        border: v("--c-border"),
        "border-subtle": v("--c-border-subtle"),
        track: v("--c-track"),
        fg: v("--c-fg"),
        muted: v("--c-muted"),
        accent: v("--c-accent"),
        "accent-hover": v("--c-accent-hover"),
        neg: v("--c-neg"),
        // Remap the palettes the app already uses onto the tokens.
        zinc: {
          50: v("--c-fg"),
          100: v("--c-fg"),
          200: v("--c-fg"),
          300: v("--c-fg-dim"),
          400: v("--c-muted"),
          500: v("--c-muted"),
          600: v("--c-muted"),
          700: v("--c-track"),
          800: v("--c-border"),
          900: v("--c-surface"),
          950: v("--c-bg"),
        },
        emerald: { 300: v("--c-accent"), 400: v("--c-accent"), 500: v("--c-accent") },
        green: { 400: v("--c-accent"), 500: v("--c-accent") },
        red: { 300: v("--c-neg"), 400: v("--c-neg"), 500: v("--c-neg") },
        amber: { 300: v("--c-accent"), 400: v("--c-accent"), 500: v("--c-accent") },
        blue: { 400: v("--c-muted"), 500: v("--c-muted") },
        purple: { 400: v("--c-muted"), 500: v("--c-muted") },
      },
      borderRadius: {
        DEFAULT: "10px",
        md: "8px",
        lg: "10px",
        xl: "12px",
        "2xl": "14px",
        full: "99px",
      },
    },
  },
  plugins: [],
};

export default config;
