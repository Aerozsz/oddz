import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oddz — Prediction market odds aggregator",
  description:
    "Live odds across Polymarket, Kalshi, Manifold and Metaculus. Spot relative value across venues.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="font-mono text-lg font-semibold tracking-tight">
              oddz
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-400">
              <Link href="/markets" className="hover:text-zinc-100">
                Markets
              </Link>
              <Link href="/divergence" className="hover:text-zinc-100">
                Divergence
              </Link>
              <Link href="/status" className="hover:text-zinc-100">
                Status
              </Link>
              <Link href="/api/v1/markets" className="hover:text-zinc-100">
                API
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mt-12 border-t border-zinc-800 py-6 text-center text-xs text-zinc-500">
          Aggregated from public APIs. Not affiliated with any venue.
        </footer>
      </body>
    </html>
  );
}
