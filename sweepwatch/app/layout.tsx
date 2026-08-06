import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sweepwatch — INTCUSDT liquidity & cluster monitor",
  description:
    "Real-time order-book withdrawal and trigger-cluster monitoring for the Binance INTCUSDT perpetual.",
};

export const viewport: Viewport = {
  themeColor: "#0d0d0d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
