/**
 * Run the served GUI script against a synthetic status payload.
 *
 * `sweep:guicheck` only proves the page parses. It does not prove `render()`
 * survives the shape of the data it is handed, and the multi-contract strip
 * reaches into nested objects (`d.dislocation.correlation`, `d.pnl`) that are
 * null or absent for most of a desk's life. A thrown TypeError inside render
 * looks exactly like a dead page, which is the failure mode this whole GUI has
 * a history of.
 *
 * So: extract the script the server actually emits, give it a DOM stub, and
 * call `render` with payloads that mirror the real ones — cold start, warming
 * up, three desks with one holding, and a single-symbol run.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("workers/sweep-control.ts"), "utf8");

function evaluateTemplate(body: string): string {
  const withoutInterpolation = body.replace(/\$\{[\s\S]*?\}/g, '"tk"');
  return Function(`return \`${withoutInterpolation.replace(/`/g, "\\`")}\`;`)() as string;
}

// The dashboard's block specifically. The file now serves two pages, and
// taking the first <script> would extract the commands page's copy handler.
const blocks = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const match = blocks.find((b) => b[1].includes("function render("));
if (!match) {
  console.error("no script block found");
  process.exit(1);
}
const script = evaluateTemplate(match[1]);

/* ------------------------------------------------------------- a DOM stub */

class El {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  value = "";
  className = "";
  disabled = false;
  onclick: (() => void) | null = null;
  constructor(readonly id: string) {}
  addEventListener() {}
  querySelectorAll() {
    return [];
  }
}

const els = new Map<string, El>();
const doc = {
  getElementById(id: string) {
    if (!els.has(id)) els.set(id, new El(id));
    return els.get(id)!;
  },
  // Only ".desk" is queried, and only right after the strip is written.
  querySelectorAll(sel: string) {
    if (sel !== ".desk") return [];
    const n = (els.get("desks")?.innerHTML.match(/class="desk/g) ?? []).length;
    return Array.from({ length: n }, (_, i) => {
      const e = new El(`desk-${i}`);
      e.dataset.sym = `S${i}`;
      return e;
    });
  },
};

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* The script calls tick()/funds()/pullLog()/runs() at load and on timers; none
 * of that is under test here, so fetch resolves to something inert and the
 * timers never fire. */
const sandbox = {
  document: doc,
  fetch: async () => ({ json: async () => ({}) }),
  setInterval: () => 0,
  confirm: () => false,
  Date,
  Math,
  Number,
  String,
  JSON,
  isFinite,
  console,
};

const run = new Function(
  ...Object.keys(sandbox),
  `${script}\n; return { render, tick };`,
) as (...a: unknown[]) => { render: (s: unknown) => void };

let api: { render: (s: unknown) => void };
try {
  api = run(...Object.values(sandbox));
  console.log("\n## the script loads");
  ok("top-level wiring runs without throwing", true);
} catch (err) {
  console.log("\n## the script loads");
  ok("top-level wiring runs without throwing", false, String(err));
  process.exit(1);
}

/* ------------------------------------------------------------- payloads */

const emptyDislocation = {
  warm: false, coupled: false, correlation: 0, ownBps: 0, groupBps: 0,
  residualBps: 0, z: 0, score: 0, peers: 0, note: "not enough history across contracts yet",
};

const desk = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol, focused: false, calibrated: true, running: true, attached: false,
  tradeable: true, warm: true, mid: 101.2, spreadBps: 3, riskUp: 30, riskDown: 55,
  signalsSeen: 12, accepted: 0, holding: 0, pnl: null, protected: null, heldMin: 0,
  lastRefusal: null, dislocation: emptyDislocation, ...over,
});

const base = (over: Record<string, unknown> = {}) => ({
  desks: [], focus: "INTCUSDT",
  engine: { running: true, uptimeSec: 300, symbol: "INTCUSDT", symbols: ["INTCUSDT"] },
  mode: "testnet", hasCredentials: true,
  health: { level: "ok", tradeable: true, summary: "live", reasons: [] },
  market: { mid: 101.2, mark: 101.2, spreadBps: 3, lwi: 0.9, lwiBid: 0.8, lwiAsk: 1,
    warm: true, riskUp: 30, riskDown: 55, nearestAbove: 102, nearestBelow: 100.5,
    session: "regular", flow: { buy: 1, sell: 1 } },
  account: { at: Date.now(), error: null, availableBalance: 5000, walletBalance: 5000,
    unrealizedPnl: 0, marginRatio: 0.01, positions: [] },
  limits: { maxPositionUsd: 1000, maxLeverage: 5, maxDailyLossUsd: 200, maxOpenPositions: 1,
    tradingEnabled: false, stopLossPct: 0.5, maxTradesPerDay: 8, lossCooldownMin: 15,
    requireCashOpen: false, minRewardRisk: 1.2, maxHoldMinutes: 30, riskPerTradePct: 4,
    sizeDerateStrength: 0.5, breakEvenAtPct: 60, minRewardOverFees: 2 },
  day: { at: Date.now(), realisedPnl: 0, drawdown: 0, trades: 0, fees: 0, funding: 0,
    lastLossAt: 0, cooldownLeftMin: 0 },
  loop: { attached: false, signalsSeen: 0, seen: 0, accepted: 0, rejected: 0, declined: 0,
    lastAcceptedAt: 0, lastRefusal: null, refusals: [] },
  execution: { available: false, armed: false, running: false, reason: "disarmed",
    history: [], stats: null },
  protection: { at: Date.now(), error: null, flat: true, protected: null, stopPrice: null,
    stopDistancePct: null, reason: null },
  ...over,
});

const render = (label: string, payload: unknown) => {
  try {
    api.render(payload);
    ok(label, true);
    return true;
  } catch (err) {
    ok(label, false, String(err));
    return false;
  }
};

console.log("\n## single contract");
{
  render("a one-desk status renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  // The panel used to hide itself here. It now hosts the contract picker, so
  // hiding it on a single desk hid the only way to add a second one — the strip
  // renders the one desk instead.
  ok("the contract strip still renders the single desk",
    (els.get("desks")?.innerHTML ?? "").includes("INTCUSDT"),
    (els.get("desks")?.innerHTML ?? "").slice(0, 60));
  ok("...and says why a second contract is worth having",
    (els.get("disNote")?.textContent ?? "").includes("One contract"),
    els.get("disNote")?.textContent ?? "");
  ok("...and the Market heading carries no ticker", els.get("mktSym")!.textContent === "",
    els.get("mktSym")!.textContent);
}

console.log("\n## after an account reset, which is the branch that blanked the page");
{
  /*
   * The bug: the rebased-day branch referenced a helper that was only in scope
   * two blocks up, so render() threw a ReferenceError partway down — and every
   * form field is populated *below* that point. The page came back with all
   * settings empty, which reads as "the update deleted my configuration".
   *
   * It only executes when the day has been rebased, so no test that did not
   * simulate a reset could have caught it.
   */
  const s = base({
    desks: [desk("INTCUSDT", { focused: true })],
    day: {
      at: Date.now(), realisedPnl: -120, drawdown: 120, trades: 3, fees: 40, funding: 0,
      lastLossAt: Date.now() - 60_000, cooldownLeftMin: 0,
      countingFrom: Date.now() - 3_600_000, rebased: true,
      rebaseReason: "balance moved -2420.00 with no ledger row behind it <check>",
    },
  });
  render("a rebased day renders", s);
  ok("the settings fields are still populated",
    els.get("maxPositionUsd")?.value !== "" && els.get("maxPositionUsd")?.value !== undefined,
    `maxPositionUsd="${els.get("maxPositionUsd")?.value}"`);
  ok("...and every other one too",
    ["maxLeverage","stopLossPct","riskPerTradePct","maxHoldMinutes"]
      .every((k) => els.get(k)?.value !== "" && els.get(k)?.value !== undefined),
    ["maxLeverage","stopLossPct","riskPerTradePct","maxHoldMinutes"]
      .map((k) => `${k}="${els.get(k)?.value}"`).join(" "));
  ok("the notice says counting moved", (els.get("dayScope")?.innerHTML ?? "").includes("not midnight"),
    els.get("dayScope")?.innerHTML ?? "");
  ok("the reason is escaped, not injected",
    !(els.get("dayScope")?.innerHTML ?? "").includes("<check>"),
    els.get("dayScope")?.innerHTML ?? "");
}

console.log("\n## three contracts, cold");
{
  const s = base({
    focus: "INTCUSDT",
    engine: { running: true, uptimeSec: 30, symbol: "INTCUSDT", symbols: ["INTCUSDT", "SNDKUSDT", "MUUSDT"] },
    desks: [
      // The realistic cold start: no price, nothing warm, no dislocation.
      desk("INTCUSDT", { focused: true, mid: null, tradeable: null, warm: null, riskUp: null, riskDown: null, signalsSeen: 0 }),
      desk("SNDKUSDT", { mid: null, tradeable: null, warm: null, riskUp: null, riskDown: null, signalsSeen: 0 }),
      desk("MUUSDT", { calibrated: false, mid: null, tradeable: null, warm: null, riskUp: null, riskDown: null, signalsSeen: 0 }),
    ],
  });
  render("a cold three-desk status renders", s);
  ok("all three desks are drawn", (els.get("desks")!.innerHTML.match(/class="desk/g) ?? []).length === 3);
  ok("the uncalibrated one is marked", els.get("desks")!.innerHTML.includes("uncal."));
  ok("the focused one is highlighted", els.get("desks")!.innerHTML.includes('class="desk on"'));
  ok("no price renders as a dash rather than NaN", !els.get("desks")!.innerHTML.includes("NaN"),
    els.get("desks")!.innerHTML.slice(0, 120));
  ok("it says the comparison is warming up", els.get("disNote")!.textContent.includes("warming up"),
    els.get("disNote")!.textContent);
  ok("the Market heading names the focus", els.get("mktSym")!.textContent === "— INTCUSDT",
    els.get("mktSym")!.textContent);
}

console.log("\n## three contracts, warm, one holding a loser");
{
  const coupled = (over: Record<string, unknown>) => ({ ...emptyDislocation, warm: true, coupled: true, correlation: 0.82, peers: 2, ...over });
  const s = base({
    focus: "SNDKUSDT",
    engine: { running: true, uptimeSec: 3000, symbol: "SNDKUSDT", symbols: ["INTCUSDT", "SNDKUSDT", "MUUSDT"] },
    desks: [
      desk("INTCUSDT", { attached: true, accepted: 2, holding: -14, pnl: -32.5, protected: true, heldMin: 12,
        dislocation: coupled({ residualBps: 41, z: 2.1, score: -0.62, note: "INTCUSDT is 41bp ahead of its 2 peers (+2.1σ), while they moved +9bp — unaccompanied moves are more often flow than news" }) }),
      desk("SNDKUSDT", { focused: true, attached: true, dislocation: coupled({ residualBps: -6, z: -0.3, note: "SNDKUSDT is tracking its peers (-6bp apart)" }) }),
      desk("MUUSDT", { calibrated: false, attached: true, dislocation: coupled({ residualBps: -12, z: -0.6, note: "MUUSDT is tracking its peers (-12bp apart)" }) }),
    ],
    account: { at: Date.now(), error: null, availableBalance: 4800, walletBalance: 5000, unrealizedPnl: -32.5,
      marginRatio: 0.04, positions: [{ symbol: "INTCUSDT", amt: -14, entry: 101, mark: 103, pnl: -32.5, liquidation: 118, leverage: 4, notional: 1442 }] },
    loop: { attached: true, signalsSeen: 340, seen: 340, accepted: 2, rejected: 60, declined: 278,
      lastAcceptedAt: Date.now() - 600000, lastRefusal: { at: Date.now() - 1000, reason: "sized out (up): reward-to-risk 0.9 below the 1.2 minimum" },
      refusals: [{ reason: "reward-to-risk below the minimum", count: 41 }, { reason: "bias called no side", count: 278 }] },
    protection: { at: Date.now(), error: null, flat: false, protected: true, stopPrice: 103.5, stopDistancePct: 0.5, reason: "stop resting 0.5% away" },
  });
  render("a warm, holding three-desk status renders", s);
  const strip = els.get("desks")!.innerHTML;
  ok("the holding desk shows its position", strip.includes("holding"), strip.slice(0, 200));
  ok("...with a loss coloured as one", strip.includes("var(--bad)"));
  ok("the flat desks show their signal counts", strip.includes("signals"));
  ok("the correlation is reported", els.get("disNote")!.innerHTML.includes("82% correlated"),
    els.get("disNote")!.innerHTML);
  ok("...and the desk that is out of line is named", els.get("disNote")!.innerHTML.includes("41bp ahead"),
    els.get("disNote")!.innerHTML);
  ok("nothing rendered as NaN or undefined", !strip.includes("NaN") && !strip.includes("undefined"));
}

console.log("\n## the group comes uncoupled");
{
  const loose = { ...emptyDislocation, warm: true, coupled: false, correlation: 0.11, peers: 2,
    note: "INTCUSDT and its peers have only been 11% correlated over the last 20 minutes — too loose for a divergence to mean anything" };
  render("an uncoupled group renders", base({
    engine: { running: true, uptimeSec: 3000, symbol: "INTCUSDT", symbols: ["INTCUSDT", "SNDKUSDT", "MUUSDT"] },
    desks: [
      desk("INTCUSDT", { focused: true, dislocation: loose }),
      desk("SNDKUSDT", { dislocation: loose }),
      desk("MUUSDT", { dislocation: loose }),
    ],
  }));
  ok("it says the factor is switched off", els.get("disNote")!.innerHTML.includes("that factor is off"),
    els.get("disNote")!.innerHTML);
}

console.log("\n## an unprotected position still shouts");
{
  render("an unprotected status renders", base({
    engine: { running: true, uptimeSec: 60, symbol: "INTCUSDT", symbols: ["INTCUSDT", "SNDKUSDT"] },
    desks: [
      desk("INTCUSDT", { focused: true, holding: 20, pnl: 5, protected: false, heldMin: 3 }),
      desk("SNDKUSDT", {}),
    ],
    protection: { at: Date.now(), error: null, flat: false, protected: false, stopPrice: null, stopDistancePct: null, reason: "no stop found" },
  }));
  ok("the banner fires", els.get("protNote")!.innerHTML.includes("NO STOP-LOSS"));
  ok("...and the strip flags it too", els.get("desks")!.innerHTML.includes("NO STOP"),
    els.get("desks")!.innerHTML.slice(0, 300));
}

console.log("\n## the would-it-trade readout");
{
  const refused = {
    known: true, symbol: "INTCUSDT", biasDirection: "up", biasSummary: "Least resistance is upward — bids thinned",
    tradeable: false,
    sides: [
      { direction: "up", ok: false, stopPct: null, target: null, rewardRisk: null, notionalUsd: null,
        reasons: ["no level ahead is 0.60% away — that is what a 0.50% stop at 1.2 reward-to-risk needs, and the furthest amplifying cluster ahead is 0.22% out",
                  "needs 4000.00 margin, only 812.40 free"] },
      { direction: "down", ok: false, stopPct: null, target: null, rewardRisk: null, notionalUsd: null,
        reasons: ["depth baseline not warm yet — the thinness reading would be meaningless"] },
    ],
  };
  render("a refusing readout renders", base({ wouldTrade: refused, desks: [desk("INTCUSDT", { focused: true })] }));
  ok("it says nothing would trade", els.get("wouldBox")!.innerHTML.includes("Nothing would trade"),
    els.get("wouldBox")!.innerHTML.slice(0, 100));
  ok("...and lists every reason, not the first", els.get("wouldBox")!.innerHTML.includes("only 812.40 free"));
  ok("...for both sides", els.get("wouldBox")!.innerHTML.includes("long") && els.get("wouldBox")!.innerHTML.includes("short"));

  const live = {
    known: true, symbol: "INTCUSDT", biasDirection: "up", biasSummary: "Least resistance is upward",
    tradeable: true,
    sides: [
      { direction: "up", ok: true, stopPct: 0.5, target: 101.9, rewardRisk: 1.6, notionalUsd: 1800, reasons: [] },
      { direction: "down", ok: false, stopPct: null, target: null, rewardRisk: null, notionalUsd: null,
        reasons: ["no level ahead is 0.60% away"] },
    ],
  };
  render("a live-setup readout renders", base({ wouldTrade: live, desks: [desk("INTCUSDT", { focused: true })] }));
  ok("it announces the setup", els.get("wouldBox")!.innerHTML.includes("A setup is live"));
  ok("...with the numbers", els.get("wouldBox")!.innerHTML.includes("1.60") && els.get("wouldBox")!.innerHTML.includes("101.90"),
    els.get("wouldBox")!.innerHTML.slice(0, 400));

  render("a no-side readout renders", base({
    wouldTrade: { ...refused, biasDirection: null, biasSummary: "Neither side is meaningfully more exposed." },
    desks: [desk("INTCUSDT", { focused: true })],
  }));
  ok("it says the bias called no side", els.get("wouldBox")!.innerHTML.includes("not calling a side"));

  render("a stopped-engine readout renders", base({
    wouldTrade: { known: false, reason: "the engine is not running" },
    desks: [desk("INTCUSDT", { focused: true })],
  }));
  ok("it says the engine is off", els.get("wouldBox")!.innerHTML.includes("engine is not running"));

  render("an absent readout renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  ok("a missing field is simply blank", els.get("wouldBox")!.innerHTML === "",
    els.get("wouldBox")!.innerHTML);
}

console.log("\n## a contract the account cannot trade");
{
  render("an untradeable-contract status renders", base({
    engine: { running: true, uptimeSec: 600, symbol: "INTCUSDT", symbols: ["INTCUSDT", "SNDKUSDT"] },
    desks: [desk("INTCUSDT", { focused: true }), desk("SNDKUSDT", {})],
    orderVenue: { url: "https://demo-fapi.binance.com", checked: true, error: null, untradeable: ["SNDKUSDT"] },
  }));
  const b = els.get("venueNote")!.innerHTML;
  ok("the banner fires", b.includes("cannot be traded"), b.slice(0, 90));
  ok("...names the contract", b.includes("SNDKUSDT"));
  ok("...names the venue", b.includes("demo-fapi.binance.com"));
  ok("...and warns the monitor will look fine", b.includes("live signals"));
  ok("...at bad severity, not a hint", b.includes("banner bad"));

  render("an all-clear venue renders", base({
    orderVenue: { url: "https://demo-fapi.binance.com", checked: true, error: null, untradeable: [] },
    desks: [desk("INTCUSDT", { focused: true })],
  }));
  ok("no banner when everything is tradeable", els.get("venueNote")!.innerHTML === "");

  render("an unchecked venue renders", base({
    orderVenue: { url: "", checked: false, error: "no credentials", untradeable: [] },
    desks: [desk("INTCUSDT", { focused: true })],
  }));
  ok("an unchecked venue stays quiet rather than crying wolf", els.get("venueNote")!.innerHTML === "");

  render("a status with no venue field renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  ok("an absent field is blank, not a crash", els.get("venueNote")!.innerHTML === "");
}

console.log("\n## the settings explainer");
{
  const withLimits = (over: Record<string, unknown>) => {
    const s = base({
      desks: [desk("INTCUSDT", { focused: true })],
      account: { at: Date.now(), error: null, availableBalance: 5000, walletBalance: 5000,
        unrealizedPnl: 0, marginRatio: 0.01, positions: [] },
    });
    s.limits = { ...s.limits, ...over };
    // The explainer reads the live form fields, which render() populates from
    // limits when the form is untouched — the same path a real page takes.
    return s;
  };

  render("a sane configuration renders", withLimits({ stopLossPct: 0.5, maxLeverage: 5, riskPerTradePct: 2, maxPositionUsd: 1000, minRewardRisk: 1.2 }));
  const sane = els.get("limitsMean")!.innerHTML;
  ok("it explains the stop is a price move", sane.includes("price move"), sane.slice(0, 120));
  ok("...and converts it to margin at leverage", sane.includes("2.5% of the margin"),
    sane.match(/[\d.]+% of the margin/)?.[0] ?? "(absent)");
  ok("...says the USD fields are notional", sane.includes("notional"));
  ok("...and works the money through", sane.includes("$100.00") && sane.includes("$1.0k"),
    sane.replace(/<[^>]+>/g, " ").slice(0, 300));
  ok("...naming the target distance needed", sane.includes("0.60% away"),
    sane.match(/[\d.]+% away/)?.[0] ?? "(absent)");
  ok("a workable stop is not flagged", !sane.includes("banner bad"));

  // The exact misconfiguration that produced a silent, permanent zero.
  render("a 50% stop renders", withLimits({ stopLossPct: 50, maxLeverage: 5, riskPerTradePct: 2, maxPositionUsd: 1000, minRewardRisk: 1.2 }));
  const bad = els.get("limitsMean")!.innerHTML;
  ok("a 50% stop is flagged as impossible", bad.includes("can never produce a trade"), bad.slice(0, 100));
  ok("...at bad severity", bad.includes("banner bad"));
  ok("...naming the 60% it would need", bad.includes("60.00% away"),
    bad.match(/[\d.]+% away/)?.[0] ?? "(absent)");
  ok("...and the ±12% that makes it impossible", bad.includes("±12%"));
  ok("...with a concrete number to use instead", /Set the stop to about [\d.]+%/.test(bad),
    bad.match(/Set the stop to about [\d.]+%/)?.[0] ?? "(absent)");

  render("a zero stop renders", withLimits({ stopLossPct: 0 }));
  ok("an empty stop explains nothing rather than dividing by zero",
    els.get("limitsMean")!.innerHTML === "", els.get("limitsMean")!.innerHTML.slice(0, 60));
}

console.log("\n## liquidation distance, not just the price");
{
  const pos = (over: Record<string, unknown>) => ({
    symbol: "BTCUSDT", amt: 0.02, entry: 60000, mark: 60000, pnl: 3,
    liquidation: 256, leverage: 1, notional: 1200, ...over,
  });
  const withPos = (p: Record<string, unknown>) => base({
    desks: [desk("INTCUSDT", { focused: true })],
    account: { at: Date.now(), error: null, availableBalance: 5000, walletBalance: 5000,
      unrealizedPnl: 3, marginRatio: 0.01, positions: [p] },
  });

  render("an unlevered position renders", withPos(pos({})));
  const far = els.get("positions")!.innerHTML;
  ok("a 1x liquidation reads as unreachable rather than as a price", far.includes("unreachable"),
    far.replace(/<[^>]+>/g, " ").slice(0, 120));
  ok("...in the reassuring colour", far.includes("var(--good)"));

  render("a levered position renders", withPos(pos({ liquidation: 57000, leverage: 20 })));
  const near = els.get("positions")!.innerHTML;
  ok("a near liquidation shows its distance", near.includes("5.0% away"),
    near.match(/[\d.]+% away/)?.[0] ?? "(absent)");
  ok("...and is coloured as the emergency it is", near.includes("var(--bad)"));

  render("a mid-distance liquidation renders", withPos(pos({ liquidation: 51000 })));
  ok("15% away warns rather than alarms", els.get("positions")!.innerHTML.includes("var(--warn)"),
    els.get("positions")!.innerHTML.match(/[\d.]+% away/)?.[0] ?? "(absent)");

  render("a position with no liquidation renders", withPos(pos({ liquidation: 0 })));
  ok("an absent liquidation says none, not NaN", els.get("positions")!.innerHTML.includes("none")
    && !els.get("positions")!.innerHTML.includes("NaN"));
}

console.log("\n## the would-trade panel shows the money, not just the notional");
{
  render("a sized proposal renders", base({
    desks: [desk("INTCUSDT", { focused: true })],
    wouldTrade: {
      known: true, symbol: "INTCUSDT", biasDirection: "up", biasSummary: "upward", tradeable: true,
      sides: [
        { direction: "up", ok: true, stopPct: 0.5, target: 101.9, rewardRisk: 1.6,
          notionalUsd: 20000, marginUsd: 5000, leverage: 4, riskUsd: 100, sizeRetained: 0.4, reasons: [] },
        { direction: "down", ok: false, stopPct: null, target: null, rewardRisk: null, notionalUsd: null,
          marginUsd: null, leverage: null, riskUsd: null, sizeRetained: null, reasons: ["nothing below"] },
      ],
    },
  }));
  const w = els.get("wouldBox")!.innerHTML;
  ok("notional and margin are both shown", w.includes("notional at 4x") && w.includes("of margin"),
    w.replace(/<[^>]+>/g, " ").slice(0, 260));
  ok("...along with what is actually at risk", w.includes("risking $100.00"));
  ok("...and how much budget the conditions left", w.includes("40% of the budget"),
    w.match(/sized to \d+% of the budget/)?.[0] ?? "(absent)");

  render("a full-size proposal renders", base({
    desks: [desk("INTCUSDT", { focused: true })],
    wouldTrade: {
      known: true, symbol: "INTCUSDT", biasDirection: "up", biasSummary: "upward", tradeable: true,
      sides: [{ direction: "up", ok: true, stopPct: 0.5, target: 101.9, rewardRisk: 1.6,
        notionalUsd: 20000, marginUsd: 5000, leverage: 4, riskUsd: 100, sizeRetained: 1, reasons: [] }],
    },
  }));
  ok("an undiminished size says nothing about derating",
    !els.get("wouldBox")!.innerHTML.includes("of the budget"));
}

console.log("\n## the readiness readout");
{
  const withR = (r: Record<string, unknown>) =>
    base({ desks: [desk("INTCUSDT", { focused: true })], readiness: r });

  render("a blocked state renders", withR({
    ready: false, armed: false,
    blockers: ["max position is 0, which refuses every setup"],
    waiting: ["INTCUSDT: depth baseline still warming (about 10 min)"],
    summary: "max position is 0, which refuses every setup",
  }));
  const b = els.get("readyBox")!.innerHTML;
  ok("it says it is not ready", b.includes("Not ready to arm"), b.slice(0, 80));
  ok("...separating what must be fixed from what to wait for",
    b.includes("HAS TO BE FIXED") && b.includes("WAITING ON"));
  ok("...at bad severity when something is broken", b.includes("banner bad"));

  render("a warming state renders", withR({
    ready: false, armed: false, blockers: [],
    waiting: ["INTCUSDT: depth baseline still warming (about 10 min)"],
    summary: "warming",
  }));
  ok("warming alone is a warning, not a failure",
    els.get("readyBox")!.innerHTML.includes("Nearly ready") &&
    els.get("readyBox")!.innerHTML.includes("banner warn"));
  ok("...and does not claim something must be fixed",
    !els.get("readyBox")!.innerHTML.includes("HAS TO BE FIXED"));

  render("a ready state renders", withR({ ready: true, armed: false, blockers: [], waiting: [], summary: "ready" }));
  ok("ready says press the button", els.get("readyBox")!.innerHTML.includes("press Start trading"));

  render("an armed state renders", withR({ ready: true, armed: true, blockers: [], waiting: [], summary: "armed" }));
  ok("armed says so plainly", els.get("readyBox")!.innerHTML.includes("Armed."));

  render("an absent readiness renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  ok("a missing field leaves it untouched rather than crashing", true);
}

console.log("\n## the open-position panel");
{
  const held = (over: Record<string, unknown> = {}) => base({
    desks: [desk("INTCUSDT", { focused: true })],
    protection: { at: Date.now(), error: null, flat: false, protected: true,
      stopPrice: 100.5, stopDistancePct: 0.5, targetPrice: 101.8, targetDistancePct: 0.8,
      entryPrice: 101.0, markPrice: 101.0, side: "long", heldMin: 7, ratcheted: false,
      reason: "stop resting", ...over },
  });

  render("a held position renders", held());
  ok("the panel is shown", els.get("livePanel")!.style.display === "", `"${els.get("livePanel")!.style.display}"`);
  const t = els.get("liveTiles")!.innerHTML;
  ok("...with entry, mark, stop and target", t.includes("Entry") && t.includes("Stop") && t.includes("Target"));
  ok("...the stop price and its distance", t.includes("100.50") && t.includes("0.50% away"), t.replace(/<[^>]+>/g, " ").slice(0, 200));
  ok("...and how long it has been held", t.includes("held 7 min of 30"));
  ok("the inputs are prefilled from what is resting",
    els.get("liveStop")!.value === 100.5 as unknown as string || String(els.get("liveStop")!.value) === "100.5",
    String(els.get("liveStop")!.value));
  ok("...with the side-correct constraint spelled out",
    els.get("liveStopHint")!.textContent.includes("below") && els.get("liveTargetHint")!.textContent.includes("above"),
    `${els.get("liveStopHint")!.textContent} / ${els.get("liveTargetHint")!.textContent}`);

  render("a short renders mirrored", held({ side: "short", markPrice: 101, entryPrice: 101 }));
  ok("a short's stop must be above", els.get("liveStopHint")!.textContent.includes("above"),
    els.get("liveStopHint")!.textContent);

  render("a position with no target renders", held({ targetPrice: null, targetDistancePct: null }));
  ok("a missing target is called out rather than shown as a number",
    els.get("liveTiles")!.innerHTML.includes("closes on the stop or the time limit"));

  render("an unprotected position renders", held({ protected: false, stopPrice: null, stopDistancePct: null }));
  ok("a missing stop shouts", els.get("liveTiles")!.innerHTML.includes("NONE")
    && els.get("liveTiles")!.innerHTML.includes("unprotected"));

  render("a ratcheted position renders", held({ ratcheted: true }));
  ok("the break-even ratchet is visible", els.get("liveTiles")!.innerHTML.includes("at break-even"));

  render("a flat account renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  ok("the panel hides when flat", els.get("livePanel")!.style.display === "none",
    els.get("livePanel")!.style.display);
}

console.log("\n## every risk field exists and is populated");
{
  render("the risk form renders", base({ desks: [desk("INTCUSDT", { focused: true })] }));
  for (const id of ["maxPositionUsd", "maxLeverage", "maxDailyLossUsd", "maxOpenPositions", "stopLossPct",
                    "riskPerTradePct", "sizeDerateStrength", "maxHoldMinutes", "minRewardRisk",
                    "breakEvenAtPct", "maxTradesPerDay", "lossCooldownMin", "requireCashOpen", "tradingEnabled",
                    "minRewardOverFees"]) {
    ok(`${id} is populated`, String(els.get(id)?.value ?? "") !== "", String(els.get(id)?.value));
  }
}

console.log("\n## money is coloured, consistently");
{
  const withDay = (d: Record<string, unknown>, acct: Record<string, unknown> = {}) => base({
    desks: [desk("INTCUSDT", { focused: true })],
    day: { at: Date.now(), realisedPnl: 0, drawdown: 0, trades: 0, fees: 0, funding: 0,
      lastLossAt: 0, cooldownLeftMin: 0, ...d },
    account: { at: Date.now(), error: null, availableBalance: 5000, walletBalance: 5000,
      unrealizedPnl: 0, marginRatio: 0.01, positions: [], ...acct },
  });

  render("a winning day renders", withDay({ realisedPnl: 420, fees: 18, trades: 5, drawdown: 0 }));
  const w = els.get("dayTiles")!.innerHTML;
  ok("a net gain is green", w.includes('class="pos"'), w.replace(/<[^>]+>/g, " ").slice(0, 150));
  ok("...with fees shown separately, not folded in", w.includes("fees"));
  ok("...and the trade count against its cap", w.includes("of 8 allowed"));

  render("a losing day renders", withDay({ realisedPnl: -260, fees: 22, trades: 4, drawdown: 282 }));
  const l = els.get("dayTiles")!.innerHTML;
  ok("a net loss is red", l.includes('class="neg"'));
  ok("...and the remaining budget warns as it runs down",
    l.includes("warnc") || l.includes('class="neg"'), l.replace(/<[^>]+>/g, " ").slice(0, 200));

  render("a spent budget renders", withDay({ realisedPnl: -300, drawdown: 250, trades: 6 }));
  ok("a spent loss budget shows zero left rather than a negative",
    !els.get("dayTiles")!.innerHTML.includes("-$"), els.get("dayTiles")!.innerHTML.replace(/<[^>]+>/g, " ").slice(0, 200));

  render("a cooldown renders", withDay({ lastLossAt: Date.now() - 60_000, cooldownLeftMin: 12 }));
  ok("an active cooldown is called out", els.get("dayTiles")!.innerHTML.includes("12m"));

  render("unrealised pnl renders", withDay({}, { unrealizedPnl: -37.5, marginRatio: 0.62 }));
  ok("a losing open position is red", els.get("upnl")!.innerHTML.includes('class="neg"'),
    els.get("upnl")!.innerHTML);
  ok("a dangerous margin ratio is red", els.get("mratio")!.innerHTML.includes('class="neg"'),
    els.get("mratio")!.innerHTML);

  render("a safe margin ratio renders", withDay({}, { marginRatio: 0.02 }));
  ok("...and a safe one is not", !els.get("mratio")!.innerHTML.includes('class="neg"'),
    els.get("mratio")!.innerHTML);

  render("a position row renders", withDay({}, {
    positions: [{ symbol: "BTCUSDT", amt: -0.02, entry: 60000, mark: 59900, pnl: 2,
      liquidation: 66000, leverage: 4, notional: 1200 }],
  }));
  const row = els.get("positions")!.innerHTML;
  ok("a short size is red and its profit green", row.includes('class="neg"') && row.includes('class="pos"'),
    row.replace(/<[^>]+>/g, " ").slice(0, 120));

  render("a flat day renders", withDay({}));
  ok("zero is neither green nor red", els.get("dayTiles")!.innerHTML.includes('class="flat"'),
    els.get("dayTiles")!.innerHTML.replace(/<[^>]+>/g, " ").slice(0, 120));
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
