import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff", 100: "#dbe6fe", 200: "#bfd3fe", 300: "#93b4fd", 400: "#6090fa",
          500: "#3b6ef6", 600: "#2552eb", 700: "#1d3fd8", 800: "#1e36af", 900: "#1e338a", 950: "#172154",
        },
        ink: { DEFAULT: "#0f172a", soft: "#334155", muted: "#64748b" },
      },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"], serif: ["var(--font-serif)", "Georgia", "serif"] },
      boxShadow: { card: "0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.06)" },
    },
  },
  plugins: [],
} satisfies Config;
