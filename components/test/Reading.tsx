"use client";
import { useState } from "react";
import type { Passage } from "@/lib/test/types";
import { QuestionGroups, QuestionNav, jumpTo } from "./Questions";

const RANGES = [[1, 13], [14, 26], [27, 40]];

export function Reading({ passages, answers, setAnswer, onFinish }: {
  passages: Passage[];
  answers: Record<string, string>;
  setAnswer: (n: number, v: string) => void;
  onFinish: () => void;
}) {
  const [active, setActive] = useState(0);
  const [mobileView, setMobileView] = useState<"passage" | "questions">("passage");
  const p = passages[active];

  const go = (i: number) => {
    setActive(i);
    document.getElementById("passage-scroll")?.scrollTo({ top: 0 });
    document.getElementById("questions-scroll")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex gap-2" role="tablist" aria-label="Reading passages">
          {passages.map((ps, i) => (
            <button key={ps.id} role="tab" aria-selected={i === active} onClick={() => go(i)}
              className={`rounded-xl px-3.5 py-1.5 text-sm font-semibold transition ${i === active ? "bg-ink text-white" : "bg-white text-ink ring-1 ring-slate-200 hover:ring-slate-300"}`}>
              Passage {i + 1}
            </button>
          ))}
        </div>
        <div className="ml-auto flex rounded-xl bg-slate-100 p-1 lg:hidden" role="tablist" aria-label="View">
          {(["passage", "questions"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={mobileView === v} onClick={() => setMobileView(v)}
              className={`rounded-lg px-3 py-1 text-sm font-semibold capitalize ${mobileView === v ? "bg-white shadow-sm" : "text-ink-soft"}`}>{v}</button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <article id="passage-scroll" aria-label={`Reading passage ${active + 1}`}
          className={`min-h-0 overflow-y-auto border-slate-200 bg-white px-5 py-6 sm:px-8 lg:block lg:border-r ${mobileView === "passage" ? "block" : "hidden"}`}>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Reading Passage {active + 1}</p>
          {p.subtitle && <p className="mt-1 text-sm text-ink-soft">{p.subtitle}</p>}
          <h2 className="mb-5 mt-4 font-serif text-2xl font-bold sm:text-3xl">{p.title}</h2>
          <div className="prose-passage max-w-[68ch] font-serif text-[17px] text-ink">
            {p.paragraphs.map((para, i) => (
              <p key={i}>{para.label && <strong className="mr-2 font-sans text-brand-700">{para.label}</strong>}{para.text}</p>
            ))}
          </div>
        </article>

        <div id="questions-scroll" className={`min-h-0 overflow-y-auto bg-slate-50 px-5 py-6 sm:px-8 lg:block ${mobileView === "questions" ? "block" : "hidden"}`}>
          <QuestionGroups groups={p.groups} answers={answers} set={setAnswer} />
          <div className="mt-10 flex flex-col-reverse justify-between gap-3 border-t border-slate-200 pt-6 sm:flex-row">
            <button className="btn-secondary" disabled={active === 0} onClick={() => go(active - 1)}>Previous passage</button>
            {active < passages.length - 1
              ? <button className="btn-primary" onClick={() => go(active + 1)}>Next passage</button>
              : <button className="btn-primary" onClick={onFinish}>Finish Reading</button>}
          </div>
        </div>
      </div>

      <QuestionNav
        parts={passages.map((_, i) => ({ label: `Passage ${i + 1}`, from: RANGES[i][0], to: RANGES[i][1] }))}
        answers={answers} activePart={active}
        onJump={(pi, n) => { if (pi !== active) go(pi); setMobileView("questions"); jumpTo(n); }}
      />
    </div>
  );
}
