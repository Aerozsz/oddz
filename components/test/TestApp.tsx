"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ListeningPart, Passage, SpeakingPart, WritingTask } from "@/lib/test/types";
import { IconAlert, IconArrowRight, IconBook, IconCheck, IconClock, IconHeadphones, IconMic, IconPen, IconPlay } from "@/components/Icons";
import { TopBar } from "./TopBar";
import { Listening, ListeningUnsupported } from "./Listening";
import { Reading } from "./Reading";
import { Writing } from "./Writing";
import { Speaking } from "./Speaking";
import { ApiError, createAttempt, patchAttempt, uploadAudio, type SaveStatus } from "./api";
import { freshState, loadState, saveState, type PersistState, type Stage } from "./state";
import { useCountdown } from "./useCountdown";
import { getVoices, pickVoices, speak, ttsSupported } from "./speech";

type Content = {
  listening: ListeningPart[];
  reading: Passage[];
  writing: WritingTask[];
  speaking: SpeakingPart[];
  timing: { listening: number; reading: number; writing: number };
  siteName: string;
  teacher: string;
};

const SECTION_LABEL: Record<string, string> = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title" className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 id="modal-title" className="text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function allTimeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) { const z = fn("timeZone"); return z.includes("UTC") ? z : ["UTC", ...z]; }
  } catch { /* fallthrough */ }
  return ["UTC", "Europe/London", "Europe/Paris", "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo"];
}

function tzLabel(tz: string) {
  try {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date());
    const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    return `${time} local time${off ? ` (${off})` : ""}`;
  } catch {
    return "";
  }
}

function DetailsForm({ onCreated, resume, onResume, onDiscard }: {
  onCreated: (s: PersistState) => void;
  resume: PersistState | null;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const zones = useMemo(allTimeZones, []);
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [tz, setTz] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => { try { setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); } catch { setTz("UTC"); } }, []);

  const validate = () => {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = "Please enter your full name.";
    const a = Number(age);
    if (!age || !Number.isInteger(a) || a < 8 || a > 100) e.age = "Please enter your age as a number between 8 and 100.";
    if (!zones.includes(tz) && tz !== "UTC") e.tz = "Please choose a time zone from the list.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setServerError(null);
    if (!validate()) {
      const first = document.querySelector<HTMLElement>("[aria-invalid='true']");
      first?.focus();
      return;
    }
    setBusy(true);
    try {
      const student = { name: name.trim(), age: Number(age), timezone: tz };
      const { id, token } = await createAttempt(student);
      onCreated(freshState(id, token, student));
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : "We couldn’t reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:py-16">
      {resume && (
        <div className="card mb-6 border-brand-200 bg-brand-50/60 p-5" role="region" aria-label="Resume test">
          <p className="font-semibold">Welcome back, {resume.student.name.split(" ")[0]}.</p>
          <p className="mt-1 text-sm text-ink-soft">You have a test in progress on this device. Your answers are saved.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="btn-primary" onClick={onResume}>Resume my test <IconArrowRight className="h-4 w-4" /></button>
            <button className="btn-ghost" onClick={onDiscard}>Start a new test instead</button>
          </div>
        </div>
      )}
      <div className="card p-6 sm:p-8">
        <p className="text-sm font-semibold text-brand-700">Step 1 of 2</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Your details</h1>
        <p className="mt-1 text-ink-soft">These are shared only with your teacher, so they can match your results to you.</p>
        <form className="mt-6 space-y-5" onSubmit={submit} noValidate>
          <div>
            <label htmlFor="name" className="label">Full name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="e.g. Maria Santos"
              aria-invalid={!!errors.name} aria-describedby={errors.name ? "name-err" : undefined} maxLength={80} />
            {errors.name && <p id="name-err" className="mt-1.5 text-sm text-rose-700">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="age" className="label">Age</label>
            <input id="age" className="input w-32" inputMode="numeric" pattern="[0-9]*" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))}
              aria-invalid={!!errors.age} aria-describedby={errors.age ? "age-err" : undefined} placeholder="e.g. 24" />
            {errors.age && <p id="age-err" className="mt-1.5 text-sm text-rose-700">{errors.age}</p>}
          </div>
          <div>
            <label htmlFor="tz" className="label">Time zone</label>
            <input id="tz" className="input" list="tz-list" value={tz} onChange={(e) => setTz(e.target.value)} autoComplete="off" spellCheck={false}
              aria-invalid={!!errors.tz} aria-describedby="tz-hint" placeholder="Start typing a city, e.g. London" />
            <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            <p id="tz-hint" className={`mt-1.5 text-sm ${errors.tz ? "text-rose-700" : "text-ink-muted"}`}>
              {errors.tz ?? (tz && zones.includes(tz) ? `Detected automatically · ${tzLabel(tz)}` : "Choose the city closest to you.")}
            </p>
          </div>
          {serverError && <p className="flex gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="alert"><IconAlert className="h-5 w-5 shrink-0" />{serverError}</p>}
          <button type="submit" className="btn-primary btn-lg w-full" disabled={busy}>
            {busy ? "Setting up your test…" : <>Continue <IconArrowRight className="h-4 w-4" /></>}
          </button>
        </form>
      </div>
    </div>
  );
}

function SystemCheck({ onContinue, name }: { onContinue: () => void; name: string }) {
  const [heard, setHeard] = useState(false);
  const [playing, setPlaying] = useState(false);
  const supported = typeof window !== "undefined" && ttsSupported();
  async function test() {
    setPlaying(true);
    const v = pickVoices(await getVoices(), { A: { gender: "f" } }).A;
    await speak("This is a sound check. If you can hear this clearly, your audio is working.", { voice: v });
    setPlaying(false);
    setHeard(true);
  }
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <p className="text-sm font-semibold text-brand-700">Step 2 of 2</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Hi {name.split(" ")[0]}, let’s check your set-up</h1>
      <div className="mt-6 space-y-4">
        <div className="card p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><IconHeadphones /></span>
            <div className="flex-1">
              <p className="font-semibold">Sound check</p>
              <p className="text-sm text-ink-soft">Put on your headphones and play the test sound. Adjust the volume until it is comfortable.</p>
            </div>
            <button className="btn-secondary" onClick={test} disabled={playing || !supported}><IconPlay className="h-4 w-4" />{playing ? "Playing…" : heard ? "Play again" : "Play sound"}</button>
          </div>
          <div className="mt-3"><ListeningUnsupported /></div>
        </div>
        <div className="card p-5">
          <p className="mb-3 font-semibold">Test rules</p>
          <ul className="space-y-2.5 text-[15px] text-ink-soft">
            {[
              [IconClock, "Each section has its own timer, which starts when you press Start. When time runs out, your answers are saved and you move on."],
              [IconHeadphones, "Each Listening recording plays once only, like the real exam."],
              [IconMic, "In Speaking, your browser will ask to use your microphone. Your answers are recorded for your teacher."],
              [IconCheck, "Answers save automatically. If something goes wrong, reopen this page on the same device to continue."],
            ].map(([I, t], i) => {
              const Icon = I as typeof IconClock;
              return <li key={i} className="flex gap-3"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" /><span>{t as string}</span></li>;
            })}
          </ul>
        </div>
      </div>
      <div className="mt-8 flex justify-end">
        <button className="btn-primary btn-lg" onClick={onContinue}>I’m ready — go to Listening <IconArrowRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function SectionIntro({ index, icon: Icon, title, duration, items, instructions, onStart }: {
  index: number; icon: typeof IconClock; title: string; duration: string; items: string; instructions: string[]; onStart: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-br from-[#2552eb] to-[#1e36af] p-6 text-white sm:p-8">
          <p className="text-sm font-semibold text-white/80">Section {index} of 4</p>
          <div className="mt-2 flex items-center gap-3"><Icon className="h-7 w-7" /><h1 className="text-3xl font-bold">{title}</h1></div>
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-white/80"><span className="flex items-center gap-1.5"><IconClock className="h-4 w-4" />{duration}</span><span>{items}</span></p>
        </div>
        <div className="p-6 sm:p-8">
          <p className="mb-3 font-semibold">Instructions</p>
          <ul className="list-disc space-y-2 pl-5 text-ink-soft">{instructions.map((i) => <li key={i}>{i}</li>)}</ul>
          <p className="mt-6 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">The timer starts as soon as you press Start. Take a break now if you need one.</p>
          <button className="btn-primary btn-lg mt-6 w-full sm:w-auto" onClick={onStart}>Start {title} <IconArrowRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

export default function TestApp({ content }: { content: Content }) {
  const [s, setS] = useState<PersistState | null>(null);
  const [resume, setResume] = useState<PersistState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<SaveStatus>("idle");
  const [confirm, setConfirm] = useState<null | { section: string; unanswered: number }>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dirty = useRef<Set<string>>(new Set());
  const sRef = useRef(s);
  sRef.current = s;

  useEffect(() => {
    const st = loadState();
    if (st && st.stage !== "done") setResume(st);
    setLoaded(true);
  }, []);

  const update = useCallback((fn: (d: PersistState) => PersistState) => {
    setS((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      saveState(next);
      return next;
    });
  }, []);

  // ----- server sync -----
  const sync = useCallback(async (section: string, extra: Record<string, unknown> = {}, opts: { stage?: Stage; submit?: boolean } = {}) => {
    const cur = sRef.current;
    if (!cur) return;
    let data: Record<string, unknown> = {};
    if (section === "listening") data = { answers: cur.listening.answers, startedAt: cur.listening.startedAt };
    if (section === "reading") data = { answers: cur.reading.answers, startedAt: cur.reading.startedAt };
    if (section === "writing") data = { task1: cur.writing.task1, task2: cur.writing.task2, startedAt: cur.writing.startedAt };
    if (section === "speaking") data = { startedAt: cur.speaking.startedAt, prepNotes: cur.speaking.prepNotes, skipped: cur.speaking.skipped };
    setSave("saving");
    try {
      await patchAttempt(cur.attemptId, cur.token, { section, data: { ...data, ...extra }, stage: opts.stage ?? cur.stage, submit: opts.submit });
      dirty.current.delete(section);
      setSave("saved");
    } catch (e) {
      setSave("error");
      throw e;
    }
  }, []);

  // Debounced autosave of whichever sections changed.
  useEffect(() => {
    const t = setInterval(() => {
      for (const sec of [...dirty.current]) sync(sec).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [sync]);

  // Warn before leaving mid-section.
  useEffect(() => {
    const inSection = s && ["listening", "reading", "writing", "speaking"].includes(s.stage);
    if (!inSection) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [s?.stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((stage: Stage) => {
    update((d) => ({ ...d, stage }));
    window.scrollTo({ top: 0 });
    const cur = sRef.current;
    if (cur) patchAttempt(cur.attemptId, cur.token, { stage }).catch(() => undefined);
  }, [update]);

  const startSection = (sec: "listening" | "reading" | "writing" | "speaking") => {
    const now = new Date();
    update((d) => {
      const n = { ...d, stage: sec as Stage };
      if (sec === "speaking") n.speaking = { ...d.speaking, startedAt: d.speaking.startedAt ?? now.toISOString() };
      else n[sec] = { ...d[sec], startedAt: d[sec].startedAt ?? now.toISOString(), deadline: d[sec].deadline ?? now.getTime() + content.timing[sec] * 1000 } as never;
      return n;
    });
    dirty.current.add(sec);
    setTimeout(() => sync(sec, {}, { stage: sec }).catch(() => undefined), 50);
  };

  const NEXT: Record<string, Stage> = { listening: "reading-intro", reading: "writing-intro", writing: "speaking-intro", speaking: "review" };

  const finishSection = useCallback(async (sec: "listening" | "reading" | "writing" | "speaking", timeUp = false) => {
    setConfirm(null);
    const finishedAt = new Date().toISOString();
    update((d) => ({ ...d, [sec]: { ...d[sec], finishedAt }, stage: NEXT[sec] }) as PersistState);
    sRef.current = sRef.current ? ({ ...sRef.current, [sec]: { ...sRef.current[sec], finishedAt }, stage: NEXT[sec] } as PersistState) : null;
    if (timeUp) setNotice(`Time is up for ${SECTION_LABEL[sec]}. Your answers have been saved.`);
    window.scrollTo({ top: 0 });
    sync(sec, { finishedAt, timeUp }, { stage: NEXT[sec] }).catch(() => { dirty.current.add(sec); });
  }, [update, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  const askFinish = (sec: "listening" | "reading" | "writing") => {
    const cur = sRef.current!;
    let unanswered = 0;
    if (sec === "writing") unanswered = [cur.writing.task1, cur.writing.task2].filter((t) => t.trim().split(/\s+/).filter(Boolean).length < 20).length;
    else for (let n = 1; n <= 40; n++) if (!cur[sec].answers[n]) unanswered++;
    setConfirm({ section: sec, unanswered });
  };

  const activeDeadline = s && (s.stage === "listening" || s.stage === "reading" || s.stage === "writing") ? s[s.stage].deadline : undefined;
  const remaining = useCountdown(activeDeadline, () => {
    const st = sRef.current?.stage;
    if (st === "listening" || st === "reading" || st === "writing") finishSection(st, true);
  });

  const setAnswer = (sec: "listening" | "reading") => (n: number, v: string) => {
    update((d) => ({ ...d, [sec]: { ...d[sec], answers: { ...d[sec].answers, [n]: v } } }));
    dirty.current.add(sec);
  };

  async function submitAll() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      for (const sec of [...dirty.current]) await sync(sec);
      await sync("speaking", { finishedAt: s?.speaking.finishedAt ?? new Date().toISOString() }, { submit: true, stage: "done" });
      update((d) => ({ ...d, stage: "done" }));
      saveState(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { update((d) => ({ ...d, stage: "done" })); saveState(null); return; }
      setSubmitError("We couldn’t submit your test. Your answers are still saved on this device — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!loaded) return <div className="grid min-h-screen place-items-center text-ink-muted">Loading…</div>;

  if (!s || s.stage === "details") {
    return (
      <>
        <TopBar />
        <DetailsForm
          resume={resume}
          onResume={() => { setS(resume); setResume(null); }}
          onDiscard={() => { saveState(null); setResume(null); }}
          onCreated={(st) => { saveState(st); setS(st); }}
        />
      </>
    );
  }

  const sectionName = s.stage.replace("-intro", "");
  const label = SECTION_LABEL[sectionName];

  return (
    <div className="min-h-screen">
      <TopBar section={label} name={s.student.name} remaining={activeDeadline ? remaining : undefined} save={["listening", "reading", "writing", "speaking"].includes(s.stage) ? save : undefined} />

      {notice && (
        <div className="mx-auto mt-4 max-w-2xl px-4" role="status">
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 p-4 text-amber-900 ring-1 ring-amber-200">
            <IconClock className="mt-0.5 h-5 w-5 shrink-0" /><p className="flex-1">{notice}</p>
            <button className="text-sm font-semibold underline" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {s.stage === "check" && <SystemCheck name={s.student.name} onContinue={() => go("listening-intro")} />}

      {s.stage === "listening-intro" && (
        <SectionIntro index={1} icon={IconHeadphones} title="Listening" duration={`${content.timing.listening / 60} minutes`} items="4 parts · 40 questions" onStart={() => startSection("listening")}
          instructions={["There are four recordings. Each one is played once only.", "Start each recording yourself with the Play button. Read the questions first.", "Answer as you listen. You can check your answers after each recording.", "Spelling matters for written answers. Follow the word limit in each instruction."]} />
      )}
      {s.stage === "listening" && (
        <Listening parts={content.listening} answers={s.listening.answers} played={s.listening.played}
          setAnswer={setAnswer("listening")}
          setPlayed={(id, n) => update((d) => ({ ...d, listening: { ...d.listening, played: { ...d.listening.played, [id]: n } } }))}
          onFinish={() => askFinish("listening")} />
      )}

      {s.stage === "reading-intro" && (
        <SectionIntro index={2} icon={IconBook} title="Reading" duration={`${content.timing.reading / 60} minutes`} items="3 passages · 40 questions" onStart={() => startSection("reading")}
          instructions={["There are three passages, getting harder as you go.", "Spend about 20 minutes on each passage.", "On a large screen the passage and questions appear side by side.", "Use the navigator at the bottom to jump to any question."]} />
      )}
      {s.stage === "reading" && <Reading passages={content.reading} answers={s.reading.answers} setAnswer={setAnswer("reading")} onFinish={() => askFinish("reading")} />}

      {s.stage === "writing-intro" && (
        <SectionIntro index={3} icon={IconPen} title="Writing" duration={`${content.timing.writing / 60} minutes`} items="2 tasks" onStart={() => startSection("writing")}
          instructions={["Task 1: describe a graph in at least 150 words (about 20 minutes).", "Task 2: write an essay of at least 250 words (about 40 minutes).", "Task 2 is worth twice as much as Task 1.", "Your writing is saved automatically as you type."]} />
      )}
      {s.stage === "writing" && (
        <Writing tasks={content.writing} values={s.writing}
          setValue={(id, v) => { update((d) => ({ ...d, writing: { ...d.writing, [id]: v } })); dirty.current.add("writing"); }}
          onFinish={() => askFinish("writing")} />
      )}

      {s.stage === "speaking-intro" && (
        <SectionIntro index={4} icon={IconMic} title="Speaking" duration="11–14 minutes" items="3 parts · recorded" onStart={() => startSection("speaking")}
          instructions={["An examiner voice will ask the questions. Answer out loud, in full sentences.", "Your answers are recorded and sent to your teacher.", "Part 2: you get one minute to prepare, then speak for up to two minutes.", "Find a quiet place and speak clearly at a normal volume."]} />
      )}
      {s.stage === "speaking" && (
        <Speaking parts={content.speaking} done={s.speaking.done}
          prepNotes={s.speaking.prepNotes ?? ""}
          setPrepNotes={(v) => update((d) => ({ ...d, speaking: { ...d.speaking, prepNotes: v } }))}
          upload={(part, blob, dur) => uploadAudio(s.attemptId, s.token, part, blob, dur)}
          onPartSaved={(part) => update((d) => ({ ...d, speaking: { ...d.speaking, done: { ...d.speaking.done, [part]: true } } }))}
          onSkip={(reason) => { update((d) => ({ ...d, speaking: { ...d.speaking, skipped: true } })); sync("speaking", { skipped: true, skipReason: reason }).catch(() => undefined); finishSection("speaking"); }}
          onFinish={() => finishSection("speaking")} />
      )}

      {s.stage === "review" && (
        <div className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Ready to submit</h1>
          <p className="mt-2 text-ink-soft">You’ve completed all four sections. Submit your test to send it to {content.teacher}.</p>
          <ul className="card mt-6 divide-y divide-slate-100">
            {[
              ["Listening", `${Object.values(s.listening.answers).filter(Boolean).length} of 40 answered`],
              ["Reading", `${Object.values(s.reading.answers).filter(Boolean).length} of 40 answered`],
              ["Writing", `Task 1: ${s.writing.task1.trim().split(/\s+/).filter(Boolean).length} words · Task 2: ${s.writing.task2.trim().split(/\s+/).filter(Boolean).length} words`],
              ["Speaking", s.speaking.skipped ? "Skipped — to be done live" : `${Object.keys(s.speaking.done).length} of 3 parts recorded`],
            ].map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-4 px-5 py-4">
                <span className="flex items-center gap-3 font-medium"><span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-100 text-emerald-700"><IconCheck className="h-4 w-4" /></span>{k}</span>
                <span className="text-right text-sm text-ink-soft">{v}</span>
              </li>
            ))}
          </ul>
          {submitError && <p className="mt-4 flex gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="alert"><IconAlert className="h-5 w-5 shrink-0" />{submitError}</p>}
          <button className="btn-primary btn-lg mt-6 w-full" onClick={submitAll} disabled={submitting}>{submitting ? "Submitting…" : "Submit my test"}</button>
        </div>
      )}

      {s.stage === "done" && (
        <div className="mx-auto max-w-xl px-4 py-16 text-center">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-emerald-700"><IconCheck className="h-8 w-8" /></span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight">Well done, {s.student.name.split(" ")[0]}!</h1>
          <p className="mt-3 text-lg text-ink-soft">Your mock test has been submitted. {content.teacher[0].toUpperCase() + content.teacher.slice(1)} will review your Writing and Speaking and go through your full results with you.</p>
          <Link href="/" className="btn-secondary mt-8">Back to home</Link>
        </div>
      )}

      {confirm && (
        <Modal title={`Finish ${SECTION_LABEL[confirm.section]}?`} onClose={() => setConfirm(null)}>
          <p className="mt-2 text-ink-soft">
            {confirm.unanswered > 0
              ? confirm.section === "writing"
                ? `One or more tasks look incomplete. You can’t come back to Writing after you finish.`
                : `You have ${confirm.unanswered} unanswered question${confirm.unanswered > 1 ? "s" : ""}. There is no penalty for guessing. You can’t come back to this section after you finish.`
              : "You can’t come back to this section after you finish."}
          </p>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button className="btn-secondary" onClick={() => setConfirm(null)}>Keep working</button>
            <button className="btn-primary" onClick={() => finishSection(confirm.section as "listening")}>Finish section</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
