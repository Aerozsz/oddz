"use client";

/** Browser text-to-speech helpers used for the listening recordings and the speaking examiner. */

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

const FEMALE = /female|samantha|karen|serena|kate|libby|sonia|susan|victoria|moira|tessa|fiona|hazel|zira|aria|jenny|emma|amy|olivia|natasha|mia|martha|catherine|google uk english female|google us english/i;
const MALE = /male|daniel|arthur|ryan|thomas|oliver|george|guy|david|mark|james|alex|fred|rishi|aaron|brian|william|google uk english male/i;

export function getVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([]);
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

function englishFirst(voices: SpeechSynthesisVoice[]) {
  const en = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.toLowerCase() === "en-gb" ? 4 : v.lang.toLowerCase().startsWith("en-au") ? 2 : 1) + (/natural|neural|online|premium|enhanced/i.test(v.name) ? 3 : 0) + (v.localService ? 0 : 1);
  return en.sort((a, b) => score(b) - score(a));
}

export function pickVoices(voices: SpeechSynthesisVoice[], speakers: Record<string, { gender: "f" | "m" }>) {
  const en = englishFirst(voices);
  const females = en.filter((v) => FEMALE.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/i, "")));
  const males = en.filter((v) => MALE.test(v.name) && !/female/i.test(v.name));
  const used = new Set<string>();
  const out: Record<string, SpeechSynthesisVoice | undefined> = {};
  for (const [name, { gender }] of Object.entries(speakers)) {
    const pool = gender === "f" ? females : males;
    const choice = pool.find((v) => !used.has(v.voiceURI)) ?? pool[0] ?? en.find((v) => !used.has(v.voiceURI)) ?? en[0];
    if (choice) used.add(choice.voiceURI);
    out[name] = choice;
  }
  return out;
}

/** Split long lines into sentences: Chrome can cut off utterances longer than ~15 seconds. */
export function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+["’”]?|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

export function speak(text: string, opts: { voice?: SpeechSynthesisVoice; pitch?: number; rate?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    if (opts.voice) { u.voice = opts.voice; u.lang = opts.voice.lang; } else u.lang = "en-GB";
    u.pitch = opts.pitch ?? 1;
    u.rate = opts.rate ?? 0.95;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearInterval(keepAlive); resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    // Chrome sometimes stalls long queues; nudging resume() keeps it going.
    const keepAlive = setInterval(() => { if (speechSynthesis.paused) speechSynthesis.resume(); }, 5000);
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
}
