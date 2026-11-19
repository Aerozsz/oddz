"use client";
import { useEffect, useRef, useState } from "react";
import type { ListeningPart, ScriptLine } from "@/lib/test/types";
import { IconHeadphones, IconPlay } from "@/components/Icons";
import { QuestionGroups, QuestionNav, jumpTo } from "./Questions";
import { getVoices, pickVoices, sentences, speak, stopSpeaking, ttsSupported } from "./speech";

type Props = {
  parts: ListeningPart[];
  answers: Record<string, string>;
  played: Record<string, number>;
  setAnswer: (n: number, v: string) => void;
  setPlayed: (partId: string, nextLine: number) => void;
  onFinish: () => void;
};

const RANGES = [[1, 10], [11, 20], [21, 30], [31, 40]];

export function Listening({ parts, answers, played, setAnswer, setPlayed, onFinish }: Props) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [line, setLine] = useState(0);
  const cancelled = useRef(false);
  const scripts = useRef<Record<string, ScriptLine[]>>({});
  const [loadError, setLoadError] = useState(false);
  const len = (p: ListeningPart) => p.lines ?? p.script.length;
  const part = parts[active];

  useEffect(() => () => { cancelled.current = true; stopSpeaking(); }, []);

  async function play(p: ListeningPart) {
    if (playing) return;
    const start = played[p.id] ?? 0;
    cancelled.current = false;
    setPlaying(p.id);
    let script = scripts.current[p.id];
    if (!script) {
      try {
        const res = await fetch(`/api/listening/${p.id}`);
        if (!res.ok) throw new Error();
        script = (await res.json()).script as ScriptLine[];
        scripts.current[p.id] = script;
      } catch {
        setPlaying(null);
        setLoadError(true);
        return;
      }
    }
    setLoadError(false);
    const voices = pickVoices(await getVoices(), p.speakers);
    for (let i = start; i < script.length; i++) {
      if (cancelled.current) return;
      setLine(i);
      const l = script[i];
      const cfg = p.speakers[l.s];
      for (const sent of sentences(l.t)) {
        if (cancelled.current) return;
        await speak(sent, { voice: voices[l.s], pitch: cfg?.pitch ?? 1, rate: cfg?.rate ?? 0.93 });
      }
      setPlayed(p.id, i + 1);
      await new Promise((r) => setTimeout(r, 350));
    }
    setPlaying(null);
  }

  const status = (p: ListeningPart) => {
    const n = played[p.id];
    if (playing === p.id) return "playing";
    if (n === undefined) return "ready";
    if (n >= len(p)) return "done";
    return "interrupted";
  };

  const st = status(part);
  const progress = st === "playing" ? (line / len(part)) * 100 : st === "done" ? 100 : ((played[part.id] ?? 0) / len(part)) * 100;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Listening parts">
          {parts.map((p, i) => {
            const s = status(p);
            return (
              <button key={p.id} role="tab" aria-selected={i === active} onClick={() => setActive(i)}
                className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${i === active ? "bg-contrast text-white" : "bg-surface text-ink ring-1 ring-slate-200 hover:ring-slate-300"}`}>
                {p.title}
                <span className={`ml-2 text-xs font-medium ${i === active ? "text-white/70" : "text-ink-muted"}`}>
                  {s === "done" ? "✓ played" : s === "playing" ? "● playing" : s === "interrupted" ? "paused" : ""}
                </span>
              </button>
            );
          })}
        </div>

        <div className="card mb-6 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><IconHeadphones /></span>
            <div className="flex-1">
              <p className="font-semibold">{part.title} recording</p>
              <p className="text-sm text-ink-soft">{part.context}</p>
            </div>
            {st === "ready" && (
              <button className="btn-primary" onClick={() => play(part)} disabled={!!playing}>
                <IconPlay className="h-4 w-4" /> Play recording
              </button>
            )}
            {st === "interrupted" && !playing && (
              <button className="btn-primary" onClick={() => play(part)}>
                <IconPlay className="h-4 w-4" /> Resume recording
              </button>
            )}
            {st === "playing" && <span className="chip bg-rose-50 text-rose-700 ring-1 ring-rose-200"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> Playing</span>}
            {st === "done" && <span className="chip bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Recording finished</span>}
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="h-full rounded-full bg-brand-500 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            {st === "ready" && "Read the questions first, then press play. You will hear the recording once only."}
            {st === "playing" && "Listen and answer as you go. You can switch tabs to look at other questions, but the recording keeps playing."}
            {st === "interrupted" && "The recording was interrupted. It will continue from where it stopped."}
            {st === "done" && "You can still review and change your answers for this part."}
          </p>
          {loadError && <p className="mt-2 text-sm font-medium text-rose-700">The recording couldn’t be loaded. Check your internet connection and press play again.</p>}
          {playing && playing !== part.id && <p className="mt-2 text-sm font-medium text-amber-800">Another part is playing right now.</p>}
        </div>

        <QuestionGroups groups={part.groups} answers={answers} set={setAnswer} />

        <div className="mt-10 flex flex-col-reverse justify-between gap-3 border-t border-slate-200 pt-6 sm:flex-row">
          <button className="btn-secondary" disabled={active === 0} onClick={() => { setActive(active - 1); window.scrollTo({ top: 0 }); }}>Previous part</button>
          {active < parts.length - 1 ? (
            <button className="btn-primary" onClick={() => { setActive(active + 1); window.scrollTo({ top: 0 }); }}>Next part</button>
          ) : (
            <button className="btn-primary" onClick={onFinish}>Finish Listening</button>
          )}
        </div>
      </div>
      <QuestionNav
        parts={parts.map((p, i) => ({ label: p.title, from: RANGES[i][0], to: RANGES[i][1] }))}
        answers={answers} activePart={active}
        onJump={(pi, n) => { setActive(pi); jumpTo(n); }}
      />
    </div>
  );
}

export function ListeningUnsupported() {
  return !ttsSupported() ? (
    <p className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">This browser cannot play the listening recordings. Please use the latest Chrome, Edge or Safari on a laptop or desktop.</p>
  ) : null;
}
