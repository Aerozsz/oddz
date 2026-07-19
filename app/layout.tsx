import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { SideNav } from "@/features/nav/SideNav";
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

// Set the persisted theme before first paint to avoid a flash. First visit
// (nothing stored) follows the OS preference instead of forcing dark.
const noFlash = `(function(){try{var t=localStorage.getItem('oddz-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

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
        <div className="flex min-h-screen flex-col lg:flex-row">
          <SideNav />
          <div className="min-w-0 flex-1">
            <main id="main" key="main" className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 rise">
              {children}
            </main>
            <footer className="mx-auto mt-12 max-w-[1400px] border-t border-border px-6 py-6 text-center text-xs text-muted">
              {brand.name} — aggregated from public APIs. Not affiliated with any venue.
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
