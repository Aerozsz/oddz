"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function PrintButton() {
  return (
    <button className="btn-secondary" onClick={() => {
      document.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
      window.print();
    }}>Print / PDF</button>
  );
}

export function DeleteAttempt({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "confirm" | "busy">("idle");
  if (stage === "idle") return <button className="btn-danger" onClick={() => setStage("confirm")}>Delete</button>;
  return (
    <span className="flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-1.5 text-sm text-rose-800 ring-1 ring-rose-200" role="alert">
      Delete {name.split(" ")[0]}’s test permanently?
      <button className="font-semibold underline" disabled={stage === "busy"} onClick={async () => {
        setStage("busy");
        const r = await fetch(`/api/admin/attempts/${id}`, { method: "DELETE" });
        if (r.ok) { router.push("/admin"); router.refresh(); } else setStage("confirm");
      }}>{stage === "busy" ? "Deleting…" : "Yes, delete"}</button>
      <button className="font-semibold" onClick={() => setStage("idle")}>Cancel</button>
    </span>
  );
}
