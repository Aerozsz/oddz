"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginForm() {
  const params = useSearchParams();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) }).catch(() => null);
    if (res?.ok) {
      const next = params.get("next");
      window.location.href = next && next.startsWith("/admin") ? next : "/admin";
      return;
    }
    setErr((await res?.json().catch(() => null))?.error ?? "Could not reach the server.");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <div>
        <label htmlFor="pw" className="label">Password</label>
        <div className="relative">
          <input id="pw" type={show ? "text" : "password"} className="input pr-16" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus aria-invalid={!!err} aria-describedby={err ? "pw-err" : undefined} />
          <button type="button" onClick={() => setShow(!show)} className="absolute inset-y-0 right-2 my-auto h-8 rounded-lg px-2 text-xs font-semibold text-ink-soft hover:bg-slate-100">{show ? "Hide" : "Show"}</button>
        </div>
        {err && <p id="pw-err" className="mt-1.5 text-sm text-rose-700" role="alert">{err}</p>}
      </div>
      <button className="btn-primary w-full" disabled={busy || !pw}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
