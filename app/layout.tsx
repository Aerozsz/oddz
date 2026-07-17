import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { NavBar } from "@/features/nav/NavBar";
import { brand, pageTitle } from "@/lib/brand";
import "./globals.css";

const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: pageTitle(), template: `%s — ${brand.name}` },
  description: brand.description,
  metadataBase: new URL(brand.url),
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

// Set the persisted theme before first paint to avoid a flash.
const noFlash = `(function(){try{var t=localStorage.getItem('oddz-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body className="font-sans antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <NavBar />
        <main id="main" className="mx-auto max-w-6xl px-6 py-6">
          {children}
        </main>
        <footer className="mt-12 border-t border-border py-6 text-center text-xs text-muted">
          {brand.name} — aggregated from public APIs. Not affiliated with any venue.
        </footer>
      </body>
    </html>
  );
}
