"use client";
import { useState } from "react";
import type { WritingTask } from "@/lib/test/types";
import { LineChart } from "@/components/LineChart";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function Writing({ tasks, values, setValue, onFinish }: {
  tasks: WritingTask[];
  values: { task1: string; task2: string };
  setValue: (id: "task1" | "task2", v: string) => void;
  onFinish: () => void;
}) {
  const [active, setActive] = useState(0);
  const t = tasks[active];
  const wc = words(values[t.id]);
  const short = wc < t.minWords;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-surface px-4 py-2.5" role="tablist" aria-label="Writing tasks">
        {tasks.map((task, i) => {
          const n = words(values[task.id]);
          return (
            <button key={task.id} role="tab" aria-selected={i === active} onClick={() => setActive(i)}
              className={`rounded-xl px-3.5 py-1.5 text-sm font-semibold transition ${i === active ? "bg-contrast text-white" : "bg-surface text-ink ring-1 ring-slate-200 hover:ring-slate-300"}`}>
              {task.title.replace("Writing ", "")}
              <span className={`ml-2 text-xs font-medium tabular-nums ${i === active ? "text-white/70" : "text-ink-muted"}`}>{n} words</span>
            </button>
          );
        })}
        <span className="ml-auto hidden text-sm text-ink-muted sm:inline">Suggested time: {t.minutes} minutes</span>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <section className="min-h-0 overflow-y-auto border-slate-200 bg-surface px-5 py-6 sm:px-8 lg:border-r" aria-label="Task instructions">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{t.title}</p>
          <p className="mt-1 text-sm text-ink-soft">You should spend about {t.minutes} minutes on this task.</p>
          <div className="mt-5 space-y-3 rounded-xl border border-slate-300 p-5 text-[16px] leading-relaxed">
            {t.prompt.map((para, i) => <p key={i} className={i === t.prompt.length - 1 ? "font-semibold" : i === 1 && t.id === "task2" ? "font-semibold" : ""}>{para}</p>)}
          </div>
          {t.chart && <div className="mt-5"><LineChart {...t.chart} /></div>}
        </section>
        <section className="flex min-h-0 flex-col bg-slate-50 px-5 py-6 sm:px-8">
          <label htmlFor={`ans-${t.id}`} className="label">Your answer</label>
          <textarea
            id={`ans-${t.id}`}
            key={t.id}
            className="input min-h-[18rem] flex-1 resize-none font-serif text-[17px] leading-relaxed"
            value={values[t.id]}
            onChange={(e) => setValue(t.id, e.target.value)}
            spellCheck={false} autoCorrect="off" autoCapitalize="sentences"
            placeholder="Start typing your answer here…"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className={`text-sm font-medium tabular-nums ${short ? "text-amber-700" : "text-emerald-700"}`} aria-live="polite">
              {wc} words {short ? `· at least ${t.minWords} required` : "· minimum reached"}
            </p>
            {active === 0
              ? <button className="btn-primary" onClick={() => setActive(1)}>Go to Task 2</button>
              : <button className="btn-primary" onClick={onFinish}>Finish Writing</button>}
          </div>
          <p className="mt-2 text-xs text-ink-muted">Spell-check is turned off, as in the real exam.</p>
        </section>
      </div>
    </div>
  );
}
