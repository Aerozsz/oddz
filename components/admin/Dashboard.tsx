"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { AttemptSummary } from "@/lib/types";
import { IconDownload, IconSearch } from "@/components/Icons";
import { BandPill, LocalTime, band } from "./format";

type SortKey = "date" | "name" | "overall" | "listening" | "reading" | "writing" | "speaking";
type Filter = "all" | "needs-grading" | "graded" | "in-progress";

const statusOf = (r: AttemptSummary): Exclude<Filter, "all"> =>
  r.status !== "submitted" ? "in-progress" : r.writing === undefined || r.speaking === undefined ? "needs-grading" : "graded";

const STATUS_UI: Record<Exclude<Filter, "all">, { label: string; cls: string }> = {
  "in-progress": { label: "In progress", cls: "bg-slate-100 text-ink-soft" },
  "needs-grading": { label: "Needs grading", cls: "bg-amber-50 text-amber-900 ring-1 ring-amber-200" },
  graded: { label: "Graded", cls: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" },
};

const avg = (xs: (number | undefined)[]) => {
  const v = xs.filter((x): x is number => x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

export default function Dashboard({ rows }: { rows: AttemptSummary[] }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const c = { all: rows.length, "needs-grading": 0, graded: 0, "in-progress": 0 } as Record<Filter, number>;
    rows.forEach((r) => c[statusOf(r)]++);
    return c;
  }, [rows]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (r: AttemptSummary): string | number => {
      switch (sort.key) {
        case "name": return r.name.toLowerCase();
        case "overall": return r.overall ?? -1;
        case "listening": return r.listening?.band ?? -1;
        case "reading": return r.reading?.band ?? -1;
        case "writing": return r.writing ?? -1;
        case "speaking": return r.speaking ?? -1;
        default: return r.createdAt;
      }
    };
    return rows
      .filter((r) => (filter === "all" || statusOf(r) === filter) && (!needle || r.name.toLowerCase().includes(needle) || r.timezone.toLowerCase().includes(needle)))
      .sort((a, b) => { const x = val(a), y = val(b); return x < y ? -sort.dir : x > y ? sort.dir : 0; });
  }, [rows, q, filter, sort]);

  const submitted = rows.filter((r) => r.status === "submitted");
  const stats = [
    { label: "Students tested", value: String(submitted.length), sub: `${counts["in-progress"]} in progress` },
    { label: "Awaiting your grading", value: String(counts["needs-grading"]), sub: "Writing / Speaking", accent: counts["needs-grading"] > 0 },
    { label: "Average overall", value: band(avg(submitted.map((r) => r.overall))), sub: "submitted tests" },
    { label: "Avg Listening · Reading", value: `${band(avg(submitted.map((r) => r.listening?.band)))} · ${band(avg(submitted.map((r) => r.reading?.band)))}`, sub: "auto-marked" },
  ];

  const allVisibleSelected = view.length > 0 && view.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(view.map((r) => r.id)));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const exportHref = (type: "summary" | "detailed") => `/api/admin/export?type=${type}${selected.size ? `&ids=${[...selected].join(",")}` : ""}`;

  const Th = ({ k, children, className = "" }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th scope="col" className={`px-3 py-3 font-semibold ${className}`} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 rounded hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === "name" ? 1 : -1 }))}>
        {children}<span aria-hidden className="text-[10px]">{sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Students</h1>
          <p className="text-ink-soft">Mock test results. Listening and Reading are marked automatically; grade Writing and Speaking to complete each report.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href={exportHref("summary")} download><IconDownload className="h-4 w-4" />Export summary{selected.size ? ` (${selected.size})` : ""}</a>
          <a className="btn-primary" href={exportHref("detailed")} download><IconDownload className="h-4 w-4" />Export detailed{selected.size ? ` (${selected.size})` : ""}</a>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className={`card p-5 ${s.accent ? "ring-2 ring-amber-200" : ""}`}>
            <dt className="text-sm text-ink-soft">{s.label}</dt>
            <dd className="mt-1 text-3xl font-bold tabular-nums">{s.value}</dd>
            <dd className="text-xs text-ink-muted">{s.sub}</dd>
          </div>
        ))}
      </dl>

      <div className="card mt-6 overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 md:flex-row md:items-center">
          <div className="relative md:w-72">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
            <input className="input pl-9" placeholder="Search by name or time zone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {(["all", "needs-grading", "graded", "in-progress"] as Filter[]).map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${filter === f ? "bg-contrast text-white" : "text-ink-soft hover:bg-slate-100"}`}>
                {f === "all" ? "All" : STATUS_UI[f].label} <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          {selected.size > 0 && (
            <p className="text-sm text-ink-soft md:ml-auto">{selected.size} selected · <button className="font-semibold text-brand-700 hover:underline" onClick={() => setSelected(new Set())}>Clear</button></p>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-lg font-semibold">No results yet</p>
            <p className="mt-1 text-ink-soft">Share the student link and results will appear here as soon as a student starts the test.</p>
            <CopyLink />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="w-10 px-4 py-3"><input type="checkbox" aria-label="Select all" checked={allVisibleSelected} onChange={toggleAll} className="accent-brand-600" /></th>
                  <Th k="name">Student</Th>
                  <Th k="date">Taken</Th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <Th k="listening" className="text-center">L</Th>
                  <Th k="reading" className="text-center">R</Th>
                  <Th k="writing" className="text-center">W</Th>
                  <Th k="speaking" className="text-center">S</Th>
                  <Th k="overall" className="text-center">Overall</Th>
                  <th className="px-3 py-3 font-semibold">Focus area</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {view.map((r) => {
                  const st = STATUS_UI[statusOf(r)];
                  return (
                    <tr key={r.id} className="group hover:bg-slate-50">
                      <td className="px-4 py-3"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="accent-brand-600" /></td>
                      <td className="px-3 py-3">
                        <Link href={`/admin/s/${r.id}`} className="font-semibold text-ink hover:text-brand-700 hover:underline">{r.name}</Link>
                        <p className="text-xs text-ink-muted">Age {r.age} · {r.timezone}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-ink-soft"><LocalTime iso={r.submittedAt ?? r.createdAt} />{r.durationMin !== undefined && <p className="text-xs text-ink-muted">{r.durationMin} min</p>}</td>
                      <td className="px-3 py-3"><span className={`chip ${st.cls}`}>{st.label}</span>{r.status !== "submitted" && <p className="mt-0.5 text-xs capitalize text-ink-muted">{r.stage.replace("-", " ")}</p>}</td>
                      <td className="px-3 py-3 text-center"><BandPill value={r.listening?.band} />{r.listening && <p className="text-[11px] text-ink-muted tabular-nums">{r.listening.raw}/40</p>}</td>
                      <td className="px-3 py-3 text-center"><BandPill value={r.reading?.band} />{r.reading && <p className="text-[11px] text-ink-muted tabular-nums">{r.reading.raw}/40</p>}</td>
                      <td className="px-3 py-3 text-center"><BandPill value={r.writing} /></td>
                      <td className="px-3 py-3 text-center"><BandPill value={r.speaking} /></td>
                      <td className="px-3 py-3 text-center text-base"><BandPill value={r.overall} provisional={r.provisional && r.overall !== undefined} /></td>
                      <td className="max-w-[16rem] px-3 py-3 text-xs text-ink-soft">{r.weakest ?? "—"}</td>
                    </tr>
                  );
                })}
                {view.length === 0 && <tr><td colSpan={10} className="p-8 text-center text-ink-soft">No students match your search.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-muted">* Provisional overall: averages only the sections marked so far. Exports include all students, or only the selected ones.</p>
    </div>
  );
}

function CopyLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn-secondary mt-5" onClick={() => { navigator.clipboard?.writeText(window.location.origin).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>
      {copied ? "Link copied" : "Copy student link"}
    </button>
  );
}
