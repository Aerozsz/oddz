/**
 * The post-mortem panel, rendered against what the endpoint actually returns.
 *
 * `sweep:guicheck` proves the page parses and says nothing about whether this
 * function survives its own payload — and this one reaches into nested
 * objects (`expectancyR.n`, `arms[].r.mean`, `entryConditions.sweepShare`) that
 * are null or absent for the whole first week of a run. A TypeError in here
 * silently stops the panel updating while the rest of the page keeps ticking,
 * which reads as "no trades yet" rather than as a bug.
 *
 * The other thing under test is the colouring, because that is where a panel
 * about uncertainty can quietly start lying. A 60% win rate whose interval runs
 * 30–85% must not be green.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("workers/sweep-control.ts"), "utf8");
// The dashboard's block specifically. The file now serves two pages, and
// taking the first <script> would extract the commands page's copy handler.
const blocks = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const match = blocks.find((b) => b[1].includes("function render("));
if (!match) { console.error("no script block"); process.exit(1); }
const script = Function(
  `return \`${match[1].replace(/\$\{[\s\S]*?\}/g, '"tk"').replace(/`/g, "\\`")}\`;`,
)() as string;

class El {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = ""; innerHTML = ""; value = ""; className = ""; disabled = false;
  onclick: (() => void) | null = null;
  constructor(readonly id: string) {}
  addEventListener() {}
  querySelectorAll() { return []; }
}
const els = new Map<string, El>();
const doc = {
  getElementById(id: string) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id)!; },
  querySelectorAll() { return []; },
};

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

let payload: unknown = {};
const sandbox = {
  document: doc,
  fetch: async () => ({ json: async () => payload }),
  setInterval: () => 0, confirm: () => false,
  Date, Math, Number, String, JSON, isFinite, console,
};
const run = new Function(...Object.keys(sandbox), `${script}\n; return { learn };`) as
  (...a: unknown[]) => { learn: () => Promise<void> };

let api: { learn: () => Promise<void> };
console.log("\n## the script loads");
try { api = run(...Object.values(sandbox)); ok("top-level wiring runs", true); }
catch (err) { ok("top-level wiring runs", false, String(err)); process.exit(1); }

const $ = (id: string) => els.get(id) ?? new El(id);

const arm = (label: string, n: number, winRate: number, mean: number) => ({
  label, n, wins: Math.round(n * winRate), winRate,
  winLo: Math.max(0, winRate - 0.2), winHi: Math.min(1, winRate + 0.2),
  r: { mean, lo: mean - 0.3, hi: mean + 0.3, n, se: 0.15 }, pnlUsd: mean * n * 100,
});

const full = {
  path: "/data/sweep-trades.jsonl", skipped: 0, total: 34,
  report: {
    n: 34, wins: 12, winRate: 0.353, winLo: 0.21, winHi: 0.52,
    expectancyR: { mean: -0.12, lo: -0.53, hi: 0.29, n: 34, se: 0.21 },
    netUsd: -740.98,
    anatomy: [
      { kind: "never-worked", count: 13, share: 0.59, costUsd: 1997.07, prescription: "an entry problem.", examples: [] },
      { kind: "gave-it-back", count: 9, share: 0.41, costUsd: 1808.65, prescription: "an exit problem.", examples: [] },
    ],
    splits: [
      { field: "sweepShare", label: "share of aggression that walked the book", sigma: 4.3, spreadR: 1.45,
        decisive: true, arms: [arm("≤ 0.62", 17, 0.06, -0.84), arm("> 0.62", 17, 0.65, 0.6)],
        note: "worth acting on" },
      { field: "utcHour", label: "hour of day (UTC)", sigma: 0.9, spreadR: 0.3, decisive: false,
        arms: [arm("≤ 12", 17, 0.4, 0.1), arm("> 12", 17, 0.3, -0.2)], note: "watch it" },
    ],
    caveats: ["34 trades is thin for 27 comparisons."],
  },
  recommendations: [
    { setting: "Break-even at", current: 60, suggested: 50, why: "reached 60% before reversing", support: "descriptive" },
    { setting: "Entry filter", current: null, suggested: null, why: "never moved in favour", support: "measured" },
  ],
  recent: [
    { at: Date.now(), symbol: "INTCUSDT", side: "long", outcome: "win", pnl: 253.98, heldMin: 78,
      mfePct: 0.28, maePct: -0.07, peakProgress: 1, regime: "liquidity-withdrawing",
      sweepShare: 0.7, exitReason: "the target filled", kind: null },
    { at: Date.now(), symbol: "INTCUSDT", side: "short", outcome: "loss", pnl: -180.4, heldMin: 22,
      mfePct: 0.01, maePct: -0.2, peakProgress: 0.03, regime: null,
      sweepShare: null, exitReason: "the stop filled", kind: "never-worked" },
  ],
};

async function render(p: unknown) { payload = p; await api.learn(); }

async function main(){
  console.log("\n## a populated panel renders");
  {
    await render(full);
    ok("the trade count lands", String($("lnN").textContent) === "34", String($("lnN").textContent));
    ok("the win rate is shown with its interval", $("lnWinD").textContent.includes("21–52%"), $("lnWinD").textContent);
    ok("expectancy is in R", $("lnExp").textContent === "-0.12R", $("lnExp").textContent);
    ok("a net loss is red", $("lnNet").style.color === "var(--bad)", $("lnNet").textContent);
    ok("both failure classes are listed", $("lnAnatomy").innerHTML.includes("never worked") && $("lnAnatomy").innerHTML.includes("gave it back"));
    ok("recommendations render with the change", $("lnRecs").innerHTML.includes("60 → 50"));
    ok("a recommendation with no number renders anyway", $("lnRecs").innerHTML.includes("Entry filter"));
    ok("both trades are in the table", ($("lnTrades").innerHTML.match(/<tr>/g) ?? []).length === 2);
    ok("the loss carries its class", $("lnTrades").innerHTML.includes("never worked"));
    ok("a null regime does not print 'null'", !$("lnTrades").innerHTML.includes(">null<"), $("lnTrades").innerHTML.slice(0, 0) || "clean");
  }

  console.log("\n## uncertainty is never coloured as if it were a result");
  {
    // Interval spans zero — the number is unknown, not bad and not good.
    ok("an expectancy interval spanning zero is amber, not green",
      $("lnExp").style.color === "var(--warn)", $("lnExp").style.color);
    ok("...and says why", $("lnExpD").textContent.includes("spans zero"), $("lnExpD").textContent);

    await render({ ...full, report: { ...full.report, winRate: 0.6, winLo: 0.3, winHi: 0.85 } });
    ok("a 60% win rate with a 30–85% interval is not green",
      $("lnWin").style.color === "var(--ink)", $("lnWin").style.color);

    await render({ ...full, report: { ...full.report, winRate: 0.7, winLo: 0.55, winHi: 0.85 } });
    ok("a win rate whose whole interval clears 50% is green",
      $("lnWin").style.color === "var(--good)", $("lnWin").style.color);

    await render({ ...full, report: { ...full.report, winRate: 0.2, winLo: 0.08, winHi: 0.44 } });
    ok("...and one whose whole interval sits below is red",
      $("lnWin").style.color === "var(--bad)", $("lnWin").style.color);

    await render({ ...full, report: { ...full.report,
      expectancyR: { mean: 0.6, lo: 0.2, hi: 1.0, n: 60, se: 0.2 } } });
    ok("an expectancy clear of zero is green", $("lnExp").style.color === "var(--good)");
  }

  console.log("\n## an undecided split is visually distinct from an actionable one");
  {
    await render(full);
    const html = $("lnSplits").innerHTML;
    ok("the actionable one is accented", html.includes("var(--good)") && html.includes("worth acting on"));
    ok("the undecided one is not", html.includes("var(--hair2)"));
    ok("both show their sample sizes", (html.match(/n=17/g) ?? []).length === 4);
  }

  console.log("\n## the empty and broken cases do not throw");
  {
    const empty = {
      path: "/data/sweep-trades.jsonl", skipped: 0, total: 0,
      report: { n: 0, wins: 0, winRate: 0, winLo: 0, winHi: 1,
        expectancyR: { mean: 0, lo: 0, hi: 0, n: 0, se: Infinity },
        netUsd: 0, anatomy: [], splits: [], caveats: [] },
      recommendations: [], recent: [],
    };
    await render(empty);
    ok("a cold start renders", String($("lnN").textContent) === "0", String($("lnN").textContent));
    ok("...and says there is nothing yet", $("lnTrades").innerHTML.includes("no closed trades"));
    ok("...without claiming a win rate", $("lnWin").textContent === "—", $("lnWin").textContent);
    ok("...or an anatomy", $("lnAnatomy").innerHTML.includes("No losing trades"));

    // The endpoint failing mid-poll must leave the panel alone, not blank it —
    // a dropped poll is not news, and blanking would read as "the log is gone".
    await render(full);
    const before = String($("lnN").textContent);
    await render({});
    ok("a payload with no report leaves the panel as it was",
      String($("lnN").textContent) === before && before === "34", before);

    // A single trade: expectancy has no interval at n=1.
    await render({ ...full, report: { ...full.report, n: 1, wins: 1, winRate: 1, winLo: 0.21, winHi: 1,
      expectancyR: { mean: 2, lo: -Infinity, hi: Infinity, n: 1, se: Infinity }, anatomy: [], splits: [] },
      recent: [full.recent[0]] });
    ok("one trade does not print an infinite interval", !$("lnExpD").textContent.includes("Infinity"), $("lnExpD").textContent);
  }

  console.log("\n## angle brackets in an exit reason cannot inject markup");
  {
    await render({ ...full, recent: [{ ...full.recent[0], exitReason: "<img src=x onerror=alert(1)>" }] });
    ok("the reason is escaped", $("lnTrades").innerHTML.includes("&lt;img"), "escaped");
    ok("...and no live tag reaches the DOM", !$("lnTrades").innerHTML.includes("<img"));
  }


}

void main().then(()=>{
  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
});
