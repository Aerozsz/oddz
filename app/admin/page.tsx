import type { Metadata } from "next";
import { AdminHeader } from "@/components/admin/AdminHeader";
import Dashboard from "@/components/admin/Dashboard";
import { listAttempts, storageMode } from "@/lib/store";
import { summarize } from "@/lib/scoring";

export const metadata: Metadata = { title: "Students", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const attempts = await listAttempts();
  const rows = attempts.map(summarize);
  return (
    <div className="min-h-screen">
      <AdminHeader />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {storageMode === "local" && process.env.VERCEL && (
          <p className="mb-6 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">Storage is not connected. Connect a Vercel Blob store to this project so results are saved.</p>
        )}
        <Dashboard rows={rows} />
      </main>
    </div>
  );
}
