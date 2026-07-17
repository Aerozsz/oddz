import type { Metadata } from "next";
import { NavBar } from "@/features/nav/NavBar";
import { brand, pageTitle } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: pageTitle(), template: `%s — ${brand.name}` },
  description: brand.description,
  metadataBase: new URL(brand.url),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <NavBar />
        <main id="main" className="mx-auto max-w-6xl px-4 py-6">
          {children}
        </main>
        <footer className="mt-12 border-t border-zinc-800 py-6 text-center text-xs text-zinc-500">
          {brand.name} — aggregated from public APIs. Not affiliated with any venue.
        </footer>
      </body>
    </html>
  );
}
