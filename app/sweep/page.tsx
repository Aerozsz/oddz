import Dashboard from "@/features/sweep/Dashboard";

export const metadata = {
  title: "Liquidity sweep monitor",
  description:
    "Real-time order-book withdrawal and trigger-cluster monitoring for the Binance INTCUSDT perpetual.",
};

// Every number on this page comes from a WebSocket opened in the visitor's own
// browser, so there is nothing for the server to render or revalidate.
export const dynamic = "force-static";

export default function SweepPage() {
  return <Dashboard />;
}
