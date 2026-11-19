import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { LocalTime } from "@/components/admin/format";
import Assessment from "@/components/admin/Assessment";
import { DeleteAttempt, PrintButton } from "@/components/admin/Actions";
import { IconChevronLeft, IconDownload } from "@/components/Icons";
import { getAttempt } from "@/lib/store";
import { breakdownByPart, breakdownByType, cefr, summarize } from "@/lib/scoring";
import { QUESTION_TYPE_LABEL } from "@/lib/test/types";
import { questionPrompt } from "@/lib/test/prompts";
import type { ObjectiveScore } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Student report", robots: { index: false } };

function AnswerTable({ title, score, section }: { title: string; score: ObjectiveScore; section: "listening" | "reading" }) {
  return (
    <details className="card group overflow-hidden" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <h3 className="font-semibold">{title} answers <span className="ml-2 font-normal text-ink-soft tabular-nums">{score.raw}/40 correct</span></h3>
        <span className="no-print text-sm text-ink-muted group-open:hidden">Show</span><span className="no-print hidden text-sm text-ink-muted group-open:inline">Hide</span>
      </summary>
      <div className="overflow-x-auto border-t border-slate-100">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-ink-muted">
            <tr><th className="px-4 py-2">Q</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Question</th><th className="px-3 py-2">Student</th><th className="px-3 py-2">Correct</th><th className="px-3 py-2"><span className="sr-only">Result</span></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {score.items.map((it) => (
              <tr key={it.n} className={it.ok ? "" : "bg-rose-50/40"}>
                <td className="px-4 py-2 font-semibold tabular-nums">{it.n}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-soft">{QUESTION_TYPE_LABEL[it.type]}</td>
                <td className="max-w-xs px-3 py-2 text-ink-soft">{questionPrompt(section, it.n)}</td>
                <td className="px-3 py-2 font-medium">{it.given || <span className="text-ink-muted">blank</span>}</td>
                <td className="px-3 py-2 text-ink-soft">{it.correct}</td>
                <td className="px-3 py-2">{it.ok ? <span className="chip bg-emerald-50 text-emerald-800">✓ Correct</span> : <span className="chip bg-rose-50 text-rose-800">✗ {it.given ? "Wrong" : "Blank"}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await getAttempt(id);
  if (!a) notFound();
  const s = summarize(a);
  const types = breakdownByType(a).sort((x, y) => x.pct - y.pct);
  const lParts = breakdownByPart(a.scores?.listening);
  const rParts = breakdownByPart(a.scores?.reading);

  const cards = [
    { label: "Listening", band: s.listening?.band, sub: s.listening ? `${s.listening.raw}/40` : "Not taken" },
    { label: "Reading", band: s.reading?.band, sub: s.reading ? `${s.reading.raw}/40` : "Not taken" },
    { label: "Writing", band: s.writing, sub: s.writing === undefined ? "Needs grading" : "Teacher graded" },
    { label: "Speaking", band: s.speaking, sub: s.speaking === undefined ? (a.speaking?.skipped ? "Skipped — do live" : "Needs grading") : "Teacher graded" },
  ];

  return (
    <div className="min-h-screen">
      <AdminHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Link href="/admin" className="no-print mb-4 inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"><IconChevronLeft className="h-4 w-4" />All students</Link>

        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{a.student.name}</h1>
            <p className="mt-1 text-ink-soft">Age {a.student.age} · {a.student.timezone}</p>
            <p className="mt-1 text-sm text-ink-muted">
              {a.status === "submitted" ? <>Submitted <LocalTime iso={a.submittedAt} /></> : <>Started <LocalTime iso={a.createdAt} /> · in progress ({a.currentStage.replace("-", " ")})</>}
              {" · "}student’s local time: <LocalTime iso={a.submittedAt ?? a.createdAt} tz={a.student.timezone} />
              {s.durationMin !== undefined && <> · took {s.durationMin} min</>}
            </p>
          </div>
          <div className="no-print flex flex-wrap gap-2">
            <a className="btn-secondary" href={`/api/admin/export?type=summary&ids=${a.id}`} download><IconDownload className="h-4 w-4" />Summary CSV</a>
            <a className="btn-secondary" href={`/api/admin/export?type=detailed&ids=${a.id}`} download><IconDownload className="h-4 w-4" />Detailed CSV</a>
            <PrintButton />
            <DeleteAttempt id={a.id} name={a.student.name} />
          </div>
        </div>

        <section className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-5" aria-label="Band scores">
          {cards.map((c) => (
            <div key={c.label} className="card p-5">
              <p className="text-sm text-ink-soft">{c.label}</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">{c.band === undefined ? "—" : c.band.toFixed(1)}</p>
              <p className="text-xs text-ink-muted">{c.sub}</p>
            </div>
          ))}
          <div className="card col-span-2 bg-contrast p-5 text-white md:col-span-1">
            <p className="text-sm text-white/70">Overall {s.provisional && s.overall !== undefined ? "(provisional)" : ""}</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">{s.overall === undefined ? "—" : s.overall.toFixed(1)}</p>
            <p className="text-xs text-white/70">≈ CEFR {cefr(s.overall)}</p>
          </div>
        </section>

        {types.length > 0 && (
          <section className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="card p-5 sm:p-6">
              <h2 className="font-bold">Accuracy by question type</h2>
              <p className="text-sm text-ink-soft">Weakest first — the best place to start tutoring.</p>
              <ul className="mt-5 space-y-3">
                {types.map((t) => (
                  <li key={`${t.section}-${t.type}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[14rem_minmax(0,1fr)_4.5rem]">
                    <span className="text-sm"><span className="font-medium">{t.label}</span> <span className="text-ink-muted">· {t.section}</span></span>
                    <span className="order-3 col-span-2 h-2.5 rounded-full bg-slate-100 sm:order-none sm:col-span-1">
                      <span className="block h-2.5 rounded-full" style={{ width: `${Math.max(t.pct, 2)}%`, background: t.pct < 50 ? "rgb(var(--c-bad))" : t.pct < 75 ? "rgb(var(--c-warn))" : "rgb(var(--c-good))" }} />
                    </span>
                    <span className="text-right text-sm font-semibold tabular-nums">{t.correct}/{t.total} <span className="font-normal text-ink-muted">{t.pct}%</span></span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 flex flex-wrap gap-4 text-xs text-ink-muted">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-status-bad" />Below 50%</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-status-warn" />50–74%</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-status-good" />75%+</span>
              </p>
            </div>
            <div className="card p-5 sm:p-6">
              <h2 className="font-bold">Score by part</h2>
              <p className="text-sm text-ink-soft">Later parts are harder in the real exam.</p>
              {[["Listening", lParts, "Part"], ["Reading", rParts, "Passage"]].map(([label, parts, word]) => (parts as typeof lParts).length > 0 && (
                <div key={label as string} className="mt-5">
                  <p className="mb-2 text-sm font-semibold">{label as string}</p>
                  <ul className="grid grid-cols-4 gap-2">
                    {(parts as typeof lParts).map((p) => (
                      <li key={p.part} className="rounded-xl bg-slate-50 p-3 text-center">
                        <p className="text-xs text-ink-muted">{word as string} {p.part}</p>
                        <p className="text-lg font-bold tabular-nums">{p.correct}<span className="text-sm font-normal text-ink-muted">/{p.total}</span></p>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8 space-y-4">
          {a.scores?.listening && <AnswerTable title="Listening" score={a.scores.listening} section="listening" />}
          {a.scores?.reading && <AnswerTable title="Reading" score={a.scores.reading} section="reading" />}
        </section>

        <Assessment
          id={a.id}
          writing={a.writing}
          speaking={a.speaking}
          grading={a.grading}
        />
        <p className="mt-8 text-xs text-ink-muted">Bands for Listening and Reading use standard IELTS Academic conversion tables. Overall = average of the four skills rounded to the nearest half band.</p>
      </main>
    </div>
  );
}
