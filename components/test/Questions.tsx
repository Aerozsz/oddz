"use client";
import type { Group, Item, Opt } from "@/lib/test/types";

type Answers = Record<string, string>;
type SetAnswer = (n: number, v: string) => void;

const Num = ({ n, answered }: { n: number | string; answered?: boolean }) => (
  <span className={`inline-grid h-7 min-w-7 shrink-0 place-items-center rounded-md px-1.5 text-xs font-bold tabular-nums ${answered ? "bg-brand-600 text-white" : "bg-slate-200 text-ink"}`}>{n}</span>
);

function OptionsBox({ title, options }: { title?: string; options: Opt[] }) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      {title && <p className="mb-2 text-sm font-semibold">{title}</p>}
      <dl className="grid gap-1.5 text-[15px]">
        {options.map((o) => (
          <div key={o.key} className="flex gap-3"><dt className="w-8 shrink-0 font-semibold">{o.key}</dt><dd>{o.text}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function ItemView({ item, group, answers, set }: { item: Item; group: Group; answers: Answers; set: SetAnswer }) {
  switch (item.kind) {
    case "heading":
      return <p className="mt-3 font-semibold text-ink first:mt-0">{item.text}</p>;
    case "text":
      return <p className="text-ink-soft">{item.text}</p>;
    case "gap": {
      const v = answers[item.n] ?? "";
      return (
        <div id={`q-${item.n}`} className="scroll-mt-28 py-1.5 leading-9">
          <span>{item.before} </span>
          <label className="inline-flex items-center">
            <span className="sr-only">Question {item.n}</span>
            <span className="relative inline-flex items-center">
              <span aria-hidden className="pointer-events-none absolute left-3 text-xs font-bold text-ink-muted">{item.n}</span>
              <input
                className="gap-input pl-8"
                value={v}
                onChange={(e) => set(item.n, e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                maxLength={60}
                data-q={item.n}
              />
            </span>
          </label>
          {item.after && <span> {item.after}</span>}
        </div>
      );
    }
    case "mcq":
      return (
        <fieldset id={`q-${item.n}`} className="scroll-mt-28">
          <legend className="mb-2 flex items-start gap-3 font-medium"><Num n={item.n} answered={!!answers[item.n]} /><span className="pt-0.5">{item.prompt}</span></legend>
          <div className="grid gap-2 pl-10">
            {item.options.map((o) => {
              const checked = answers[item.n] === o.key;
              return (
                <label key={o.key} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 transition ${checked ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-slate-200 bg-surface hover:border-slate-300"}`}>
                  <input type="radio" name={`q${item.n}`} value={o.key} checked={checked} onChange={() => set(item.n, o.key)} className="mt-1 accent-brand-600" data-q={item.n} />
                  <span><strong className="mr-2">{o.key}</strong>{o.text}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    case "multi": {
      const chosen = item.ns.map((n) => answers[n]).filter(Boolean);
      const toggle = (key: string) => {
        let next = chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
        if (next.length > item.ns.length) next = next.slice(next.length - item.ns.length);
        next.sort();
        item.ns.forEach((n, i) => set(n, next[i] ?? ""));
      };
      return (
        <fieldset id={`q-${item.ns[0]}`} className="scroll-mt-28">
          <span id={`q-${item.ns[1]}`} />
          <legend className="mb-2 flex items-start gap-3 font-medium"><Num n={`${item.ns[0]}–${item.ns[item.ns.length - 1]}`} answered={chosen.length === item.ns.length} /><span className="pt-0.5">{item.prompt}</span></legend>
          <p className="mb-2 pl-10 text-sm text-ink-muted">Select {item.ns.length} answers · {chosen.length} of {item.ns.length} selected</p>
          <div className="grid gap-2 pl-10">
            {item.options.map((o) => {
              const checked = chosen.includes(o.key);
              return (
                <label key={o.key} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 transition ${checked ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-slate-200 bg-surface hover:border-slate-300"}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.key)} className="mt-1 accent-brand-600" data-q={item.ns[0]} />
                  <span><strong className="mr-2">{o.key}</strong>{o.text}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    case "select": {
      const v = answers[item.n] ?? "";
      return (
        <div id={`q-${item.n}`} className="flex scroll-mt-28 flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-4">
          <label htmlFor={`sel-${item.n}`} className="flex flex-1 items-start gap-3"><Num n={item.n} answered={!!v} /><span className="pt-0.5">{item.prompt}</span></label>
          <select id={`sel-${item.n}`} value={v} onChange={(e) => set(item.n, e.target.value)} className="input w-full sm:w-72" data-q={item.n}>
            <option value="">Choose…</option>
            {group.options?.map((o) => <option key={o.key} value={o.key}>{o.key} — {o.text.length > 48 ? o.text.slice(0, 46) + "…" : o.text}</option>)}
          </select>
        </div>
      );
    }
    case "tfng": {
      const choices = group.tfng === "YNNG" ? ["YES", "NO", "NOT GIVEN"] : ["TRUE", "FALSE", "NOT GIVEN"];
      const v = answers[item.n] ?? "";
      return (
        <fieldset id={`q-${item.n}`} className="scroll-mt-28">
          <legend className="mb-2 flex items-start gap-3"><Num n={item.n} answered={!!v} /><span className="pt-0.5">{item.prompt}</span></legend>
          <div className="flex flex-wrap gap-2 pl-10" role="radiogroup">
            {choices.map((c) => (
              <label key={c} className={`cursor-pointer rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition focus-within:ring-4 focus-within:ring-brand-100 ${v === c ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-surface text-ink hover:border-slate-400"}`}>
                <input type="radio" className="sr-only" name={`q${item.n}`} checked={v === c} onChange={() => set(item.n, c)} data-q={item.n} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
  }
}

export function QuestionGroups({ groups, answers, set }: { groups: Group[]; answers: Answers; set: SetAnswer }) {
  return (
    <div className="space-y-8">
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`${g.id}-h`}>
          <h3 id={`${g.id}-h`} className="text-base font-bold">{g.range}</h3>
          <p className="mb-4 mt-1 text-[15px] text-ink-soft">{g.instructions}</p>
          {g.options && <OptionsBox title={g.optionsTitle} options={g.options} />}
          {g.boxed ? (
            <div className="rounded-xl border border-slate-300 bg-surface p-4 sm:p-5">
              {g.title && <p className="mb-2 text-center font-semibold">{g.title}</p>}
              {g.items.map((it, i) => <ItemView key={i} item={it} group={g} answers={answers} set={set} />)}
            </div>
          ) : (
            <div className="space-y-5">
              {g.title && <p className="font-semibold">{g.title}</p>}
              {g.items.map((it, i) => <ItemView key={i} item={it} group={g} answers={answers} set={set} />)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Bottom navigator: one button per question, grouped by part. */
export function QuestionNav({ parts, answers, activePart, onJump }: {
  parts: { label: string; from: number; to: number }[];
  answers: Answers;
  activePart: number;
  onJump: (partIndex: number, n: number) => void;
}) {
  const total = parts.reduce((s, p) => s + (p.to - p.from + 1), 0);
  const done = parts.reduce((s, p) => { for (let n = p.from; n <= p.to; n++) if (answers[n]) s++; return s; }, 0);
  return (
    <nav aria-label="Question navigator" className="no-print sticky bottom-0 z-20 border-t border-slate-200 bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 overflow-x-auto px-4 py-2.5">
        <span className="shrink-0 text-xs font-semibold text-ink-muted tabular-nums">{done}/{total} answered</span>
        {parts.map((p, pi) => (
          <div key={p.label} className={`flex shrink-0 items-center gap-1 rounded-xl px-2 py-1 ${pi === activePart ? "bg-brand-50" : ""}`}>
            <span className="mr-1 text-xs font-semibold text-ink-soft">{p.label}</span>
            {Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i).map((n) => (
              <button key={n} type="button" onClick={() => onJump(pi, n)}
                aria-label={`Question ${n}${answers[n] ? ", answered" : ", not answered"}`}
                className={`h-7 w-7 rounded-md text-xs font-semibold tabular-nums transition focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-200 ${answers[n] ? "bg-brand-600 text-white hover:bg-brand-500" : "border border-slate-300 bg-surface text-ink hover:border-slate-400"}`}>
                {n}
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

export function jumpTo(n: number) {
  requestAnimationFrame(() => {
    const el = document.getElementById(`q-${n}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const input = el?.querySelector<HTMLElement>("input,select") ?? document.querySelector<HTMLElement>(`[data-q="${n}"]`);
    setTimeout(() => input?.focus({ preventScroll: true }), 350);
  });
}
