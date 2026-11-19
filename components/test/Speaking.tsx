"use client";
import { useEffect, useRef, useState } from "react";
import type { SpeakingPart } from "@/lib/test/types";
import { IconAlert, IconCheck, IconMic, IconStop } from "@/components/Icons";
import { getVoices, pickVoices, speak, stopSpeaking } from "./speech";
import { mmss } from "./useCountdown";

const CAP: Record<string, number> = { part1: 6 * 60, part2: 4 * 60, part3: 7 * 60 };

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function useRecorder(stream: MediaStream | null) {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);

  // Live input level, so students can see the mic is working.
  useEffect(() => {
    if (!stream) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); ctx.close().catch(() => undefined); };
  }, [stream]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((Date.now() - started.current) / 1000), 250);
    return () => clearInterval(t);
  }, [recording]);

  const start = () => {
    if (!stream) return;
    const mimeType = pickMime();
    const r = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.start(1000);
    rec.current = r;
    started.current = Date.now();
    setElapsed(0);
    setRecording(true);
  };

  const stop = () => new Promise<{ blob: Blob; duration: number }>((resolve) => {
    const r = rec.current;
    const duration = (Date.now() - started.current) / 1000;
    setRecording(false);
    if (!r || r.state === "inactive") return resolve({ blob: new Blob(chunks.current), duration });
    r.onstop = () => resolve({ blob: new Blob(chunks.current, { type: r.mimeType || "audio/webm" }), duration });
    r.stop();
  });

  return { start, stop, level, elapsed, recording };
}

function Meter({ level }: { level: number }) {
  return (
    <div className="flex h-6 items-end gap-0.5" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className={`w-1.5 rounded-full transition-all ${level * 12 > i ? "bg-emerald-500" : "bg-slate-200"}`} style={{ height: `${30 + i * 6}%` }} />
      ))}
    </div>
  );
}

type Phase = "intro" | "prep" | "talk" | "uploading" | "saved" | "error";

export function Speaking({ parts, done, upload, onPartSaved, onSkip, onFinish, prepNotes, setPrepNotes }: {
  parts: SpeakingPart[];
  done: Record<string, boolean>;
  upload: (part: string, blob: Blob, duration: number) => Promise<unknown>;
  onPartSaved: (part: string) => void;
  onSkip: (reason: string) => void;
  onFinish: () => void;
  prepNotes: string;
  setPrepNotes: (v: string) => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [idx, setIdx] = useState(() => Math.max(0, parts.findIndex((p) => !done[p.id])));
  const [phase, setPhase] = useState<Phase>("intro");
  const [q, setQ] = useState(0);
  const [prepLeft, setPrepLeft] = useState(0);
  const [examinerTalking, setExaminerTalking] = useState(false);
  const pending = useRef<{ blob: Blob; duration: number } | null>(null);
  const voice = useRef<SpeechSynthesisVoice | undefined>(undefined);
  const r = useRecorder(stream);
  const part = parts[idx];
  const allDone = parts.every((p) => done[p.id]);

  const questions = part && part.id !== "part2" ? part.topics.flatMap((t) => t.questions) : [];

  async function requestMic() {
    setMicError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      setStream(s);
    } catch (e) {
      const name = (e as Error)?.name;
      setMicError(name === "NotAllowedError" ? "Microphone access was blocked. Click the microphone or lock icon in your browser’s address bar, allow access, then try again." : "No microphone was found. Please connect one and try again.");
    }
  }

  useEffect(() => {
    requestMic();
    getVoices().then((v) => { voice.current = pickVoices(v, { Examiner: { gender: "f" } }).Examiner; });
    return () => { stopSpeaking(); };
  }, []);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  async function say(text: string) {
    setExaminerTalking(true);
    await speak(text, { voice: voice.current, rate: 0.95 });
    setExaminerTalking(false);
  }

  // Part 2 preparation countdown
  useEffect(() => {
    if (phase !== "prep") return;
    if (prepLeft <= 0) { beginTalk(); return; }
    const t = setTimeout(() => setPrepLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, prepLeft]);

  // Hard cap on recording length
  useEffect(() => {
    if (phase === "talk" && r.elapsed >= CAP[part.id]) finishPart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.elapsed, phase]);

  // Part 2: examiner asks the follow-up when the long turn time is up
  const askedFollowUp = useRef(false);
  useEffect(() => {
    if (part?.id === "part2" && phase === "talk" && r.elapsed >= part.talkSeconds && !askedFollowUp.current) {
      askedFollowUp.current = true;
      say(`Thank you. ${part.followUp}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.elapsed, phase]);

  function startPart() {
    setQ(0);
    askedFollowUp.current = false;
    if (part.id === "part2") {
      setPrepLeft(part.prepSeconds);
      setPhase("prep");
      say(`Now I'm going to give you a topic, and I'd like you to talk about it for one to two minutes. You have one minute to prepare. ${part.cue.topic}`);
      return;
    }
    r.start();
    setPhase("talk");
    say(questions[0]);
  }

  function beginTalk() {
    stopSpeaking();
    r.start();
    setPhase("talk");
    say("All right. Remember you have one to two minutes for this. Please start speaking now.");
  }

  function nextQuestion() {
    const n = q + 1;
    setQ(n);
    stopSpeaking();
    say(questions[n]);
  }

  async function finishPart() {
    stopSpeaking();
    const res = await r.stop();
    pending.current = res;
    await send();
  }

  async function send() {
    if (!pending.current) return;
    setPhase("uploading");
    try {
      await upload(part.id, pending.current.blob, pending.current.duration);
      pending.current = null;
      onPartSaved(part.id);
      setPhase("saved");
    } catch {
      setPhase("error");
    }
  }

  function nextPart() {
    if (idx < parts.length - 1) { setIdx(idx + 1); setPhase("intro"); window.scrollTo({ top: 0 }); }
  }

  if (!stream && !allDone) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <div className="card p-6 sm:p-8">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-700"><IconMic /></span>
          <h2 className="mt-4 text-xl font-bold">Microphone needed</h2>
          {micError
            ? <p className="mt-2 flex gap-2 text-rose-700"><IconAlert className="mt-0.5 h-5 w-5 shrink-0" />{micError}</p>
            : <p className="mt-2 text-ink-soft">Please allow microphone access when your browser asks, so your answers can be recorded.</p>}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button className="btn-primary" onClick={requestMic}>Try again</button>
            <button className="btn-secondary" onClick={() => onSkip(micError ?? "Microphone unavailable")}>Skip speaking (do it live with my teacher)</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <ol className="mb-6 grid grid-cols-3 gap-2" aria-label="Speaking parts">
        {parts.map((p, i) => (
          <li key={p.id} className={`rounded-xl px-3 py-2 text-sm ${i === idx ? "bg-contrast text-white" : done[p.id] ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "bg-surface text-ink-soft ring-1 ring-slate-200"}`}>
            <span className="font-semibold">Part {i + 1}</span>{done[p.id] && <span className="ml-1">✓</span>}
          </li>
        ))}
      </ol>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <h2 className="font-bold">{part.title}</h2>
          {phase === "talk" && (
            <span className="flex items-center gap-3">
              <Meter level={r.level} />
              <span className="chip bg-rose-50 text-rose-700 ring-1 ring-rose-200 tabular-nums"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />REC {mmss(Math.floor(r.elapsed))}</span>
            </span>
          )}
        </div>

        <div className="p-6 sm:p-8">
          {phase === "intro" && (
            <>
              <p className="text-ink-soft">{part.intro}</p>
              <div className="mt-5 flex items-center gap-3 rounded-xl bg-slate-50 p-4">
                <Meter level={r.level} />
                <p className="text-sm text-ink-soft">Say something to check your microphone. The bars should move.</p>
              </div>
              <button className="btn-primary btn-lg mt-6" onClick={startPart}><IconMic /> Start {part.title.split(": ")[0]}</button>
            </>
          )}

          {part.id === "part2" && (phase === "prep" || phase === "talk") && (
            <div className="space-y-5">
              <div className="rounded-2xl border-2 border-ink/80 bg-amber-50/40 p-5">
                <p className="text-lg font-semibold">{part.cue.topic}</p>
                <p className="mt-3 text-sm font-medium">You should say:</p>
                <ul className="ml-5 mt-1 list-disc space-y-0.5">{part.cue.points.map((pt) => <li key={pt}>{pt}</li>)}</ul>
                <p className="mt-1">{part.cue.closing}</p>
              </div>
              {phase === "prep" ? (
                <>
                  <div className="flex items-center justify-between rounded-xl bg-brand-50 p-4">
                    <p className="font-semibold text-brand-900">Preparation time</p>
                    <p className="text-2xl font-bold tabular-nums text-brand-700" role="timer">{mmss(prepLeft)}</p>
                  </div>
                  <label className="label" htmlFor="prep-notes">Notes (optional, for you only)</label>
                  <textarea id="prep-notes" className="input min-h-28" value={prepNotes} onChange={(e) => setPrepNotes(e.target.value)} placeholder="Jot down key words…" />
                  <button className="btn-primary" onClick={beginTalk}>I’m ready, start speaking</button>
                </>
              ) : (
                <>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                    <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.min(100, (r.elapsed / part.talkSeconds) * 100)}%` }} />
                  </div>
                  <p className="text-sm text-ink-soft">
                    {r.elapsed < 60 ? "Keep talking. Aim for the full two minutes." : r.elapsed < part.talkSeconds ? "Good. Keep going until the two minutes are up." : <><strong>Examiner:</strong> {part.followUp}</>}
                  </p>
                  {prepNotes && <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-ink-soft"><span className="font-semibold">Your notes: </span>{prepNotes}</p>}
                  <button className="btn-primary" onClick={finishPart} disabled={r.elapsed < 20}><IconStop className="h-4 w-4" /> Finish Part 2</button>
                </>
              )}
            </div>
          )}

          {part.id !== "part2" && phase === "talk" && (
            <div>
              <p className="text-sm font-semibold text-ink-muted">Question {q + 1} of {questions.length}</p>
              <p className="mt-3 min-h-[4rem] text-2xl font-semibold leading-snug" aria-live="polite">{questions[q]}</p>
              <p className="mt-2 h-5 text-sm text-ink-muted">{examinerTalking ? "The examiner is asking the question…" : "Answer out loud, then go to the next question."}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                {q < questions.length - 1
                  ? <button className="btn-primary" onClick={nextQuestion}>Next question</button>
                  : <button className="btn-primary" onClick={finishPart}><IconStop className="h-4 w-4" /> Finish {part.title.split(": ")[0]}</button>}
              </div>
            </div>
          )}

          {phase === "uploading" && <p className="flex items-center gap-3 font-medium"><span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> Saving your recording…</p>}

          {phase === "error" && (
            <div>
              <p className="flex gap-2 font-medium text-rose-700"><IconAlert className="mt-0.5 h-5 w-5" /> We couldn’t upload your recording. Check your internet connection and try again.</p>
              <button className="btn-primary mt-4" onClick={send}>Retry upload</button>
            </div>
          )}

          {phase === "saved" && (
            <div>
              <p className="flex items-center gap-2 font-semibold text-emerald-700"><IconCheck /> {part.title.split(": ")[0]} saved.</p>
              {idx < parts.length - 1
                ? <button className="btn-primary mt-5" onClick={nextPart}>Continue to Part {idx + 2}</button>
                : <button className="btn-primary mt-5" onClick={onFinish}>Finish Speaking</button>}
            </div>
          )}
        </div>
      </div>
      {allDone && phase !== "saved" && (
        <div className="mt-6 text-center"><button className="btn-primary" onClick={onFinish}>All parts recorded, continue</button></div>
      )}
    </div>
  );
}
