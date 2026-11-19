"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Attempt, SpeakingGrade, WritingGrade } from "@/lib/types";

const roundBand = (x: number) => Math.floor(x * 2 + 0.5) / 2;
const words = (s?: string) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

const WRITING_CRITERIA: { key: keyof WritingGrade; t1: string; t2: string; hint: string }[] = [
  { key: "ta", t1: "Task Achievement", t2: "Task Response", hint: "Covers the task fully; clear overview (T1) or position (T2); relevant, extended ideas." },
  { key: "cc", t1: "Coherence & Cohesion", t2: "Coherence & Cohesion", hint: "Logical organisation, paragraphing, and linking devices used naturally." },
  { key: "lr", t1: "Lexical Resource", t2: "Lexical Resource", hint: "Range and precision of vocabulary, collocation, spelling." },
  { key: "gra", t1: "Grammatical Range & Accuracy", t2: "Grammatical Range & Accuracy", hint: "Variety of structures and the proportion of error-free sentences." },
];
const SPEAKING_CRITERIA: { key: keyof SpeakingGrade; label: string; hint: string }[] = [
  { key: "fc", label: "Fluency & Coherence", hint: "Speaks at length without noticeable effort; logical, well-linked answers." },
  { key: "lr", label: "Lexical Resource", hint: "Range of vocabulary, paraphrase, idiomatic language." },
  { key: "gra", label: "Grammatical Range & Accuracy", hint: "Complex structures; frequency of errors." },
  { key: "p", label: "Pronunciation", hint: "Intelligibility, stress, intonation and connected speech." },
];

function BandPicker({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value?: number; onChange: (v: number | undefined) => void }) {
  return (
    <fieldset className="py-3">
      <legend className="text-sm font-semibold">{label}</legend>
      <p id={`${id}-hint`} className="mb-2 text-xs text-ink-muted">{hint}</p>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-describedby={`${id}-hint`}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((b) => (
          <label key={b} className={`grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-sm font-semibold tabular-nums transition focus-within:ring-4 focus-within:ring-brand-100 ${value === b ? "bg-brand-600 text-white" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
            <input type="radio" className="sr-only" name={id} checked={value === b} onChange={() => onChange(b)} />
            {b}
          </label>
        ))}
        {value !== undefined && <button type="button" className="ml-1 text-xs font-medium text-ink-muted hover:text-ink" onClick={() => onChange(undefined)}>Clear</button>}
      </div>
    </fieldset>
  );
}

type Partial4<T> = { [K in keyof T]?: number };
const complete = <T extends object>(g: Partial4<T>, keys: (keyof T)[]) => keys.every((k) => typeof g[k] === "number");
const avgBand = (g: Record<string, number | undefined>) => {
  const v = Object.values(g).filter((x): x is number => typeof x === "number");
  return v.length === 4 ? roundBand(v.reduce((a, b) => a + b, 0) / 4) : undefined;
};

export default function Assessment({ id, writing, speaking, grading }: { id: string; writing: Attempt["writing"]; speaking: Attempt["speaking"]; grading: Attempt["grading"] }) {
  const router = useRouter();
  const [t1, setT1] = useState<Partial4<WritingGrade>>(grading?.task1 ?? {});
  const [t2, setT2] = useState<Partial4<WritingGrade>>(grading?.task2 ?? {});
  const [sp, setSp] = useState<Partial4<SpeakingGrade>>(grading?.speaking ?? {});
  const [notes, setNotes] = useState(grading?.notes ?? "");
  const [state, setState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");

  const mark = <T,>(set: React.Dispatch<React.SetStateAction<T>>) => (fn: (p: T) => T) => { set(fn); setState("dirty"); };
  const setT1d = mark(setT1), setT2d = mark(setT2), setSpd = mark(setSp);

  useEffect(() => {
    if (state !== "dirty") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [state]);

  const b1 = avgBand(t1), b2 = avgBand(t2), bs = avgBand(sp);
  const wBand = b1 !== undefined && b2 !== undefined ? roundBand((b1 + 2 * b2) / 3) : undefined;

  async function save() {
    setState("saving");
    const body = {
      task1: complete(t1, ["ta", "cc", "lr", "gra"]) ? t1 : null,
      task2: complete(t2, ["ta", "cc", "lr", "gra"]) ? t2 : null,
      speaking: complete(sp, ["fc", "lr", "gra", "p"]) ? sp : null,
      notes,
    };
    const r = await fetch(`/api/admin/attempts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (r?.ok) { setState("saved"); router.refresh(); } else setState("error");
  }

  const tasks = [
    { key: "task1" as const, title: "Writing Task 1", min: 150, text: writing?.task1, g: t1, set: setT1d, band: b1 },
    { key: "task2" as const, title: "Writing Task 2", min: 250, text: writing?.task2, g: t2, set: setT2d, band: b2 },
  ];

  return (
    <>
      <section className="mt-10" aria-labelledby="writing-h">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="writing-h" className="text-xl font-bold">Writing</h2>
          <p className="text-sm text-ink-soft">Writing band: <strong className="tabular-nums text-ink">{wBand?.toFixed(1) ?? "n/a"}</strong> <span className="text-ink-muted">(Task 2 counts double)</span></p>
        </div>
        {!writing ? <p className="card p-5 text-ink-soft">The student has not reached the Writing section yet.</p> : (
          <div className="space-y-5">
            {tasks.map((t) => {
              const wc = words(t.text);
              return (
                <div key={t.key} className="card grid overflow-hidden lg:grid-cols-[1.5fr_1fr]">
                  <div className="border-slate-100 p-5 sm:p-6 lg:border-r">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{t.title}</h3>
                      <span className={`chip ${wc < t.min ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200" : "bg-slate-100 text-ink-soft"}`}>{wc} words{wc < t.min ? ` · under ${t.min}` : ""}</span>
                      {writing.timeUp && <span className="chip bg-slate-100 text-ink-soft">Time ran out</span>}
                    </div>
                    {t.text?.trim()
                      ? <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 font-serif text-[16px] leading-relaxed print:max-h-none">{t.text}</div>
                      : <p className="rounded-xl bg-slate-50 p-4 text-ink-muted">No response.</p>}
                  </div>
                  <div className="divide-y divide-slate-100 p-5 sm:p-6">
                    {WRITING_CRITERIA.map((c) => (
                      <BandPicker key={c.key} id={`${t.key}-${c.key}`} label={t.key === "task1" ? c.t1 : c.t2} hint={c.hint} value={t.g[c.key]} onChange={(v) => t.set((p) => ({ ...p, [c.key]: v }))} />
                    ))}
                    <p className="pt-3 text-sm">Task band: <strong className="tabular-nums">{t.band?.toFixed(1) ?? "n/a"}</strong></p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="speaking-h">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="speaking-h" className="text-xl font-bold">Speaking</h2>
          <p className="text-sm text-ink-soft">Speaking band: <strong className="tabular-nums text-ink">{bs?.toFixed(1) ?? "n/a"}</strong></p>
        </div>
        <div className="card grid overflow-hidden lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-4 border-slate-100 p-5 sm:p-6 lg:border-r">
            {speaking?.skipped && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">The student skipped the recorded speaking test{speaking.skipReason ? `: “${speaking.skipReason}”` : ""}. Assess it in a live session and enter the bands here.</p>}
            {!speaking && <p className="text-ink-soft">The student has not reached the Speaking section yet.</p>}
            {(["part1", "part2", "part3"] as const).map((p, i) => {
              const rec = speaking?.recordings.find((r) => r.part === p);
              return (
                <div key={p}>
                  <p className="mb-1.5 text-sm font-semibold">Part {i + 1} {rec && <span className="font-normal text-ink-muted">· {Math.floor(rec.durationSec / 60)}:{String(Math.round(rec.durationSec % 60)).padStart(2, "0")}</span>}</p>
                  {rec ? <audio controls preload="none" className="w-full" src={`/api/admin/audio/${id}/${p}`} /> : <p className="text-sm text-ink-muted">No recording.</p>}
                </div>
              );
            })}
            {speaking?.prepNotes && <div><p className="text-sm font-semibold">Part 2 preparation notes</p><p className="mt-1 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-ink-soft">{speaking.prepNotes}</p></div>}
          </div>
          <div className="divide-y divide-slate-100 p-5 sm:p-6">
            {SPEAKING_CRITERIA.map((c) => (
              <BandPicker key={c.key} id={`sp-${c.key}`} label={c.label} hint={c.hint} value={sp[c.key]} onChange={(v) => setSpd((prev) => ({ ...prev, [c.key]: v }))} />
            ))}
          </div>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="notes-h">
        <h2 id="notes-h" className="mb-3 text-xl font-bold">Teacher notes</h2>
        <textarea className="input min-h-32" placeholder="Strengths, weaknesses, lesson plan ideas… (included in exports)" value={notes} onChange={(e) => { setNotes(e.target.value); setState("dirty"); }} />
      </section>

      <div className="no-print sticky bottom-4 z-20 mt-8 flex justify-end">
        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
          <span className={`text-sm ${state === "error" ? "text-rose-700" : "text-ink-soft"}`} aria-live="polite">
            {state === "dirty" ? "Unsaved changes" : state === "saving" ? "Saving…" : state === "saved" ? "Grades saved" : state === "error" ? "Couldn’t save. Try again." : "Grades are only saved when you press Save"}
          </span>
          <button className="btn-primary" onClick={save} disabled={state === "saving" || state === "clean" || state === "saved"}>Save grades</button>
        </div>
      </div>
    </>
  );
}
