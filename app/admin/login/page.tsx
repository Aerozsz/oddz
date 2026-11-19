import type { Metadata } from "next";
import { Suspense } from "react";
import { Logo } from "@/components/Logo";
import LoginForm from "@/components/admin/LoginForm";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata: Metadata = { title: "Teacher sign in", robots: { index: false } };

export default function LoginPage() {
  return (
    <div className="relative grid min-h-screen place-items-center px-4 py-10">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center"><Logo /></div>
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-bold">Teacher dashboard</h1>
          <p className="mt-1 text-sm text-ink-soft">Sign in to see your students’ results.</p>
          <Suspense><LoginForm /></Suspense>
        </div>
      </div>
    </div>
  );
}
