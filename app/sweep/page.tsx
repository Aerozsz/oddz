import Dashboard from "@/features/sweep/Dashboard";

export const metadata = {
  title: "Liquidity sweep monitor",
  description:
    "Real-time order-book withdrawal and trigger-cluster monitoring for the Binance INTCUSDT perpetual.",
  // Unlisted, not private. Taking it out of the nav removes the only link to
  // it, but robots.txt allows the whole site, so a shared or guessed URL could
  // still be indexed and turn up in a search. This keeps it out of results.
  // Anyone with the URL still gets the page.
  robots: { index: false, follow: false },
};

// Every number on this page comes from a WebSocket opened in the visitor's own
// browser, so there is nothing for the server to render or revalidate.
export const dynamic = "force-static";

export default function SweepPage() {
  return <Dashboard />;
}
