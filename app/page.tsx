import Link from "next/link";
import { Logo } from "@/components/Logo";
import { IconArrowRight, IconBook, IconCheck, IconClock, IconHeadphones, IconMic, IconPen } from "@/components/Icons";
import { SITE } from "@/lib/site";
import { ThemeToggle } from "@/components/ThemeToggle";

const SECTIONS = [
  { icon: IconHeadphones, name: "Listening", time: "35 min", detail: "4 recordings · 40 questions", desc: "Conversations and talks on everyday and academic topics. Each recording plays once." },
  { icon: IconBook, name: "Reading", time: "60 min", detail: "3 passages · 40 questions", desc: "Academic texts with true/false/not given, headings, matching and completion tasks." },
  { icon: IconPen, name: "Writing", time: "60 min", detail: "2 tasks", desc: "Describe a graph (150+ words) and write an opinion essay (250+ words)." },
  { icon: IconMic, name: "Speaking", time: "≈ 12 min", detail: "3 parts · recorded", desc: "Answer interview questions, give a 2-minute talk and discuss ideas. Your answers are recorded." },
];

const CHECKLIST = [
  "About 3 hours of uninterrupted time",
  "A laptop or desktop with Chrome, Edge or Safari",
  "Headphones or speakers, and a microphone",
  "A quiet room and a stable internet connection",
];

const FAQ = [
  { q: "Is this the real IELTS exam?", a: "No. It is an original practice test written in the official IELTS Academic format, with the same timings, question types and band scoring." },
  { q: "What if my browser closes or the internet drops?", a: "Your answers are saved automatically as you go. Open the test again on the same device and browser and you can continue from where you stopped. The section timer keeps running, as in a real exam." },
  { q: "When will I get my results?", a: `Listening and Reading are marked automatically. Writing and Speaking are assessed by ${SITE.teacher}, who will go through your full results with you.` },
  { q: "Can I take a break?", a: "You can rest between sections: the next timer only starts when you press Start. Try not to stop in the middle of a section." },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1 text-sm">
            <a href="#sections" className="btn-ghost hidden sm:inline-flex">What’s included</a>
            <a href="#faq" className="btn-ghost hidden sm:inline-flex">FAQ</a>
            <ThemeToggle />
            <Link href="/test" className="btn-primary">Start test</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.1fr_.9fr]">
            <div>
              <p className="chip mb-5 bg-brand-50 text-brand-700 ring-1 ring-brand-100">IELTS Academic · Full mock test</p>
              <h1 className="text-4xl font-bold tracking-tight text-ink sm:text-5xl lg:text-6xl">
                Find out where your English <span className="text-brand-600">really</span> is.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
                A full-length, timed mock test covering Listening, Reading, Writing and Speaking. Your results show {SITE.teacher} exactly what to focus on in your lessons.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link href="/test" className="btn-primary btn-lg">
                  Start the mock test <IconArrowRight />
                </Link>
                <span className="flex items-center gap-2 text-sm text-ink-muted"><IconClock className="h-4 w-4" /> About 2 hours 50 minutes in total</span>
              </div>
            </div>

            <div className="card relative p-6 sm:p-8" aria-label="Example score report">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Example score report</p>
                  <p className="mt-1 text-lg font-semibold">Overall band</p>
                </div>
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-600 text-2xl font-bold text-white">6.5</div>
              </div>
              <ul className="space-y-3">
                {[["Listening", 7.0], ["Reading", 6.5], ["Writing", 6.0], ["Speaking", 6.5]].map(([k, v]) => (
                  <li key={k as string}>
                    <div className="mb-1 flex justify-between text-sm"><span className="font-medium">{k}</span><span className="tabular-nums text-ink-soft">{(v as number).toFixed(1)}</span></div>
                    <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${((v as number) / 9) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
              <p className="mt-5 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Focus area: <strong>Reading: True / False / Not Given (50%)</strong></p>
            </div>
          </div>
        </section>

        <section id="sections" className="border-t border-slate-100 bg-slate-50 py-16 md:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Four sections, just like the real exam</h2>
            <p className="mt-2 max-w-2xl text-ink-soft">The sections run in the official order, each with its own timer. You can rest between sections.</p>
            <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {SECTIONS.map((s, i) => (
                <li key={s.name} className="card flex flex-col p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-700"><s.icon /></span>
                    <span className="text-sm font-semibold text-ink-muted">0{i + 1}</span>
                  </div>
                  <h3 className="text-lg font-semibold">{s.name}</h3>
                  <p className="mt-0.5 text-sm font-medium text-brand-700">{s.time} · {s.detail}</p>
                  <p className="mt-3 text-sm leading-relaxed text-ink-soft">{s.desc}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="py-16 md:py-20">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Before you start</h2>
              <p className="mt-2 text-ink-soft">Set yourself up like it’s exam day. You’ll get the most accurate result.</p>
              <ul className="mt-6 space-y-3">
                {CHECKLIST.map((c) => (
                  <li key={c} className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"><IconCheck className="h-4 w-4" /></span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">How it works</h2>
              <ol className="mt-6 space-y-5">
                {[
                  ["Enter your details", "Your name, age and time zone, so your results reach the right person."],
                  ["Take the test", "Work through the four sections. Everything saves automatically."],
                  ["Get a personalised plan", `${SITE.teacher[0].toUpperCase() + SITE.teacher.slice(1)} reviews your answers and plans lessons around your weakest areas.`],
                ].map(([t, d], i) => (
                  <li key={t} className="flex gap-4">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 font-semibold text-white">{i + 1}</span>
                    <div><p className="font-semibold">{t}</p><p className="text-ink-soft">{d}</p></div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section id="faq" className="border-t border-slate-100 bg-slate-50 py-16 md:py-20">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Frequently asked questions</h2>
            <div className="mt-8 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-surface">
              {FAQ.map((f) => (
                <details key={f.q} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {f.q}
                    <span aria-hidden className="text-xl text-ink-muted transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 leading-relaxed text-ink-soft">{f.a}</p>
                </details>
              ))}
            </div>
            <div className="mt-12 text-center">
              <Link href="/test" className="btn-primary btn-lg">Start the mock test <IconArrowRight /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-sm text-ink-muted sm:flex-row sm:px-6">
          <p>Original practice material in the IELTS Academic format. Not affiliated with the official IELTS partners.</p>
          <Link href="/admin" className="hover:text-ink">Teacher sign in</Link>
        </div>
      </footer>
    </div>
  );
}
