import { recordNews } from "./news-store";
import { available, unavailable, type SourceDef } from "./sources";

/**
 * The collection loop, as a library rather than a script.
 *
 * It began as the body of `workers/sweep-news.ts`, which meant collecting
 * anything required a second terminal and a second command that had to be
 * started before the control server and remembered after every reboot. That is
 * a setup step disguised as a feature: the operator who forgets it does not get
 * an error, they get an agent that silently trades with no awareness of the
 * outside world — indistinguishable from a quiet week.
 *
 * So the loop lives here, the control server starts one in-process, and the
 * standalone worker becomes a thin wrapper for anyone who still wants it on its
 * own. Two copies running at once is handled rather than prevented: the store
 * deduplicates on the headline, and the control server yields to a standalone
 * poller when it sees one, so the worst case is a few wasted requests during
 * the handover rather than a doubled feed.
 *
 * What it does not do, stated plainly because the opposite is easy to assume:
 * it does not read a story, judge it, or decide anything. It records that a
 * headline of a given impact existed at a given time, and counts how often each
 * ticker was mentioned. Impact is inferred from keywords, which is crude and
 * admitted as crude — the agent uses it only to stand back from a market that is
 * reacting to something, never to take a view on what the something means.
 */

const HIGH = /\b(hack|exploit|halt|suspend|bankrupt|liquidat|SEC|lawsuit|ban|seiz|collapse|emergency|flash crash|depeg|outage)\b/i;
const MEDIUM = /\b(ETF|approval|rate|inflation|CPI|FOMC|Fed|regulat|upgrade|fork|listing|delist|partnership|acquisition)\b/i;

const impactOf = (t: string): "high" | "medium" | "low" =>
  HIGH.test(t) ? "high" : MEDIUM.test(t) ? "medium" : "low";

/**
 * Exchange announcements are graded on their own words, not the news keywords.
 *
 * "Binance Will Delist X" is the most price-moving sentence this feed can carry
 * and contains none of the terms the generic matcher looks for.
 */
function announcementImpact(t: string): "high" | "medium" | "low" {
  if (/\b(delist|remov|suspend|halt|maintenance|discontinu)\b/i.test(t)) return "high";
  if (/\b(will list|listing|launch|perpetual|futures|adds?)\b/i.test(t)) return "high";
  if (/\b(update|adjust|leverage|margin|funding|tier)\b/i.test(t)) return "medium";
  return "low";
}

/** Symbols named in a headline, so mentions and per-symbol queries can find them. */
const TICKERS: [RegExp, string][] = [
  [/\bbitcoin\b|\bBTC\b/i, "BTCUSDT"],
  [/\bethereum\b|\bETH\b|\bether\b/i, "ETHUSDT"],
  [/\bsolana\b|\bSOL\b/i, "SOLUSDT"],
  [/\bbinance\b|\bBNB\b/i, "BNBUSDT"],
  [/\bripple\b|\bXRP\b/i, "XRPUSDT"],
];

/**
 * How often each ticker is being mentioned, against its own baseline.
 *
 * This is what social is actually good for. Reading a Reddit thread tells you
 * nothing a trading agent can use; a tenfold jump in how often BTC is mentioned
 * in five minutes tells you the crowd has noticed something, and it is
 * measurable, fast and needs no judgement about what any individual post means.
 *
 * Module-level rather than per-poller, so a reader can ask for the velocity
 * without holding a handle to whoever happens to be collecting.
 */
interface Chatter {
  /** Timestamps of mentions inside the trailing window. */
  recent: number[];
  /** What "normal" looks like for this ticker, in mentions per window. */
  baseline: number;
  firstAt: number;
  lastAt: number;
}

const mentions = new Map<string, Chatter>();

/** The trailing window the count is taken over. */
const WINDOW_MS = 5 * 60_000;
/** Half-life of the baseline. Long enough that a real spike does not raise it. */
const BASELINE_HALF_LIFE_MS = 30 * 60_000;
/**
 * How long a ticker must have been observed before a velocity is reported.
 *
 * Without this the metric fires hardest exactly when it knows least. The
 * baseline starts at the first count it sees, so twelve posts arriving in the
 * first poll after a restart read as a sixfold spike — a fabricated one, purely
 * because the baseline had not had time to be anything. That is not a harmless
 * warm-up: it derates every position for the first minutes after every restart,
 * and it writes a false chatterVelocity onto every trade taken in that window,
 * which quietly poisons the very post-mortem the field exists to feed.
 *
 * Six windows is enough for the baseline to reflect an actual rate. Until then
 * the honest answer is "normal", because nothing is yet known to be abnormal.
 */
const WARMUP_MS = 6 * WINDOW_MS;

/**
 * Bring a ticker up to date as of `now`.
 *
 * Called on read as well as on write, which is the whole point: the count is
 * over a trailing window, so it only falls if something prunes it. Updating
 * solely on mention meant a ticker that spiked and then went silent kept its
 * spike forever — the derate would go on and never lift, because the event that
 * would clear it is the absence of events.
 */
function settle(m: Chatter, now: number) {
  const cutoff = now - WINDOW_MS;
  while (m.recent.length && m.recent[0] < cutoff) m.recent.shift();

  const dt = now - m.lastAt;
  if (dt > 0) {
    const alpha = 1 - Math.pow(0.5, dt / BASELINE_HALF_LIFE_MS);
    m.baseline += alpha * (m.recent.length - m.baseline);
    m.lastAt = now;
  }
}

function noteMention(symbol: string, now: number) {
  const m = mentions.get(symbol) ?? { recent: [], baseline: 0, firstAt: now, lastAt: now };
  settle(m, now);
  m.recent.push(now);
  mentions.set(symbol, m);
}

/** Mentions in the trailing window over baseline. 1 is normal. */
export function mentionVelocity(symbol: string, now = Date.now()): number {
  const m = mentions.get(symbol);
  if (!m) return 1;
  settle(m, now);
  // Refuses rather than guesses, for the reason WARMUP_MS spells out.
  if (now - m.firstAt < WARMUP_MS) return 1;
  // A ticker mentioned less than once per window has no meaningful baseline to
  // be a multiple of, and dividing by a fraction manufactures a large number
  // out of a single post.
  if (m.baseline < 1) return 1;
  return m.recent.length / m.baseline;
}

/** True once this ticker's baseline means something. */
export function chatterWarm(symbol: string, now = Date.now()): boolean {
  const m = mentions.get(symbol);
  return Boolean(m && now - m.firstAt >= WARMUP_MS && m.baseline >= 1);
}

/** Every ticker currently being talked about more than usual. */
export function chatterSpikes(threshold = 3, now = Date.now()): { symbol: string; velocity: number }[] {
  return [...mentions.keys()]
    .map((symbol) => ({ symbol, velocity: mentionVelocity(symbol, now) }))
    .filter((x) => x.velocity > threshold)
    .sort((a, b) => b.velocity - a.velocity);
}

/*
 * Test support. Nothing in the running system calls these.
 *
 * Exported because the alternative is worse: the only way to exercise a
 * thirty-minute baseline against a five-minute window is to control the clock,
 * and a metric whose warm behaviour cannot be tested is a metric that gets
 * shipped on the strength of its cold behaviour alone.
 */
export function __resetChatter() {
  mentions.clear();
}

export function __noteMention(symbol: string, at: number) {
  noteMention(symbol, at);
}

export interface PollerStatus {
  recorded: number;
  cycles: number;
  sources: number;
  unavailable: string;
  errors: string;
  velocity: string;
  lastPollAt: number;
}

export interface NewsPoller {
  stop(): void;
  status(): PollerStatus;
  /** Poll everything now, ignoring each source's schedule. For tests and /api. */
  pollNow(): Promise<void>;
}

export interface PollerOptions {
  /** Progress lines. Absent means silent, which is what the control server wants. */
  onLine?: (line: string) => void;
  /** Called for every high-impact headline, so a caller can surface it. */
  onHigh?: (headline: string, source: string) => void;
  recordedBy?: string;
}

export function startNewsPoller(opts: PollerOptions = {}): NewsPoller {
  const nextDue = new Map<string, number>();
  const errors = new Map<string, string>();
  let recorded = 0;
  let cycles = 0;
  let lastPollAt = 0;
  let ticking = false;
  let stopped = false;

  const tag = opts.recordedBy ?? "sweep:news";

  async function pollSource(src: SourceDef, now: number) {
    const req = src.build();
    if (!req) return;
    try {
      const res = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const items = src.parse(await res.text());

      // Six hours: past that it is history, and the store already caps its age.
      const fresh = items.filter((i) => now - i.at < 6 * 3_600_000 && i.at <= now + 60_000);
      for (const i of fresh) {
        const symbols = TICKERS.filter(([re]) => re.test(i.headline)).map(([, sym]) => sym);
        for (const sym of symbols) noteMention(sym, now);

        /*
         * Forums and social are counted, not recorded.
         *
         * A Reddit post is not a headline and filing it as one would bury the
         * announcements and wires that are. What they contribute is the mention
         * velocity above; only announcements and wires enter the store as items.
         */
        if (src.kind === "forum" || src.kind === "social") continue;

        const r = recordNews({
          headline: i.headline,
          summary: null,
          sourceUrl: i.url,
          source: src.label,
          impact: src.kind === "announcement" ? announcementImpact(i.headline) : impactOf(i.headline),
          at: i.at,
          symbols,
          recordedBy: `${tag}/${src.id}`,
        });
        if (r.ok && r.item) {
          recorded++;
          if (r.item.impact === "high") opts.onHigh?.(i.headline, src.label);
        }
      }
      errors.delete(src.id);
    } catch (err) {
      errors.set(src.id, err instanceof Error ? err.message : String(err));
    }
  }

  /*
   * The tick currently in flight, so a caller can wait for it.
   *
   * Dropping an overlapping call is right for the timer — a slow source must
   * not end up with two polls running against it, which is how a rate limit
   * becomes a ban — but wrong for an explicit `pollNow()`, which returned
   * instantly and reported the state from *before* the poll it was supposed to
   * have performed. A caller asking for fresh data and being handed stale data
   * with no error is the worst available answer.
   */
  let inFlight: Promise<void> | null = null;

  async function runDue(force: boolean) {
    if (stopped) return;
    if (ticking) {
      await inFlight;
      return;
    }
    ticking = true;
    try {
      const now = Date.now();
      const due = force ? available() : available().filter((s) => (nextDue.get(s.id) ?? 0) <= now);
      if (!due.length) return;
      cycles++;
      lastPollAt = now;
      await Promise.all(
        due.map(async (s) => {
          await pollSource(s, now);
          nextDue.set(s.id, Date.now() + s.everySec * 1000);
        }),
      );
      if (opts.onLine) {
        const hot = chatterSpikes();
        opts.onLine(
          `${recorded} recorded` +
            (hot.length ? ` · chatter spike: ${hot.map((h) => `${h.symbol} ${h.velocity.toFixed(1)}x`).join(", ")}` : "") +
            (errors.size ? ` · ${errors.size} source(s) erroring` : ""),
        );
      }
    } finally {
      ticking = false;
    }
  }

  // Stagger the first poll of each source so a start does not fire everything at
  // once and collect rate limits from three services simultaneously.
  let offset = 0;
  for (const s of available()) {
    nextDue.set(s.id, Date.now() + offset);
    offset += 2000;
  }

  const kick = (force: boolean) => {
    if (ticking) return inFlight ?? Promise.resolve();
    inFlight = runDue(force);
    return inFlight;
  };

  const timer = setInterval(() => void kick(false), 5_000);
  // Never the reason a process stays alive. The control server has an HTTP
  // server holding it open and the standalone worker has its own guard; a
  // collection loop keeping a finished process from exiting is a bug.
  timer.unref?.();
  void kick(false);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    status: () => ({
      recorded,
      cycles,
      sources: available().length,
      unavailable: unavailable().map((s) => s.id).join(","),
      errors: [...errors.entries()].map(([k, v]) => `${k}: ${v}`).join(" | "),
      velocity: [...mentions.keys()].map((k) => `${k} ${mentionVelocity(k).toFixed(1)}x`).join(" "),
      lastPollAt,
    }),
    async pollNow() {
      // Twice when a tick was already running: the first await joins it, the
      // second runs the forced pass the caller actually asked for.
      await kick(true);
      if (!stopped) await kick(true);
    },
  };
}
