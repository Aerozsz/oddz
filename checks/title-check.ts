/**
 * The price in the tab title, in the states nobody sees while developing.
 *
 * A developer looking at this page has a live socket, so the only branch ever
 * exercised by hand is the working one. The branches that matter are the other
 * three — cold start, socket down, socket open but silent — and getting any of
 * them wrong means a tab quietly showing a price that stopped being true some
 * time ago, on the window that places orders.
 *
 * Both surfaces are tested from their real source: the React hook by calling
 * it, and the control GUI by extracting the script the server actually emits
 * and running `render` against a status payload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Snapshot } from "@/lib/sweep/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

/* ------------------------------------------------ the React hook, /sweep */

/*
 * useEffect run eagerly rather than deferred. The hook's only job is to
 * compute a string and assign it, and both happen in one pass, so a stub that
 * calls the effect body immediately tests exactly what React would run.
 */
const titles: string[] = [];
const globalAny = globalThis as unknown as { document?: { title: string } };
globalAny.document = { get title() { return titles[titles.length - 1] ?? ""; }, set title(v: string) { titles.push(v); } };

// Resolved from the repo root: this file lives outside it, so a bare
// require.resolve looks in the wrong node_modules.
const reactStub = { useEffect: (fn: () => void | (() => void)) => { fn(); } };
const reactPath = require.resolve("react", { paths: [resolve(".")] });
require.cache[reactPath] = { id: reactPath, exports: reactStub, loaded: true } as never;

const { useTabTitle } = require("@/features/sweep/useTabTitle") as typeof import("@/features/sweep/useTabTitle");

const snap = (over: Partial<Snapshot> = {}, conn: Partial<Snapshot["connection"]> = {}): Snapshot =>
  ({
    ts: 1_000_000,
    meta: { symbol: "INTCUSDT", pricePrecision: 2 },
    connection: { socket: "open", bookSynced: true, lastMessageAt: 1_000_000, messagesPerSec: 40, error: null, ...conn },
    last: 30.42, mid: 30.415, mark: null, bestBid: 30.41, bestAsk: 30.42,
    ...over,
  }) as unknown as Snapshot;

const title = (s: Snapshot) => { titles.length = 0; useTabTitle(s, "INTCUSDT", "Liquidity sweep monitor"); return titles[0] ?? ""; };

console.log("\n## the live case");
{
  ok("price first, then the ticker", title(snap()) === "30.42 INTC", title(snap()));
  ok("the quote currency is dropped", !title(snap()).includes("USDT"));
  ok("precision comes from the contract, not a guess",
    title(snap({ meta: { symbol: "BTCUSDT", pricePrecision: 1 } } as Partial<Snapshot>)) === "30.4 BTC",
    title(snap({ meta: { symbol: "BTCUSDT", pricePrecision: 1 } } as Partial<Snapshot>)));
  ok("the exchange's symbol wins over the configured one",
    title(snap({ meta: { symbol: "SNDKUSDT", pricePrecision: 2 } } as Partial<Snapshot>)).endsWith("SNDK"));
}

console.log("\n## a price is never shown when it might be stale");
{
  ok("a closed socket shows no price",
    title(snap({}, { socket: "closed" })) === "INTC — no data", title(snap({}, { socket: "closed" })));
  ok("connecting shows no price", !title(snap({}, { socket: "connecting" })).includes("30.42"));
  ok("an unsynced book shows no price", !title(snap({}, { bookSynced: false })).includes("30.42"));

  // Open socket, but nothing has arrived for a minute.
  const silent = snap({ ts: 1_060_000 }, { lastMessageAt: 1_000_000 });
  ok("a socket that has gone silent for a minute shows no price",
    title(silent) === "INTC — no data", title(silent));

  // The threshold is deliberately far more forgiving than the page's 5s, so a
  // quiet overnight book does not flicker the tab twice a minute.
  const quiet = snap({ ts: 1_010_000 }, { lastMessageAt: 1_000_000 });
  ok("...but a ten-second gap does not, unlike the page's own stall check",
    quiet && title(quiet) === "30.42 INTC", title(quiet));
}

console.log("\n## the cold start says nothing rather than something wrong");
{
  const cold = snap({ ts: 0, last: null, mid: null }, { socket: "connecting", bookSynced: false, lastMessageAt: 0 });
  ok("before the first tick there is no price", title(cold) === "INTC — no data", title(cold));
  const zero = snap({ last: 0, mid: 0 });
  ok("a zero price is not printed as 0.00", title(zero) === "INTC — no data", title(zero));
  const noMeta = snap({ meta: null });
  ok("no contract metadata falls back to the configured symbol", title(noMeta) === "30.42 INTC", title(noMeta));
}

/* ------------------------------------------- the control GUI, sweep:control */

const source = readFileSync(resolve("workers/sweep-control.ts"), "utf8");
// Selected by content, not by position. There are two pages now — the
// dashboard and the commands reference — and taking the first <script> silently
// tested the wrong one.
const blocks = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const match = blocks.find((b) => b[1].includes("function render("));
if (!match) { console.error("no script block with render()"); process.exit(1); }
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
let guiTitle = "Sweep agent control";
const doc = {
  getElementById(id: string) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id)!; },
  querySelectorAll(sel: string) {
    if (sel !== ".desk") return [];
    const n = (els.get("desks")?.innerHTML.match(/class="desk/g) ?? []).length;
    return Array.from({ length: n }, (_, i) => { const e = new El(`d${i}`); e.dataset.sym = `S${i}`; return e; });
  },
  get title() { return guiTitle; },
  set title(v: string) { guiTitle = v; },
};

const sandbox = {
  document: doc, fetch: async () => ({ json: async () => ({}) }),
  setInterval: () => 0, confirm: () => false,
  Date, Math, Number, String, JSON, isFinite, console,
};
const gui = (new Function(...Object.keys(sandbox), `${script}\n; return { render };`) as
  (...a: unknown[]) => { render: (s: unknown) => void })(...Object.values(sandbox));

const emptyDislocation = { warm: false, coupled: false, correlation: 0, ownBps: 0, groupBps: 0, residualBps: 0, z: 0, score: 0, peers: 0, note: "" };
const desk = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol, focused: false, calibrated: true, running: true, attached: false,
  tradeable: true, warm: true, mid: 30.415, spreadBps: 3, riskUp: 30, riskDown: 55,
  signalsSeen: 12, accepted: 0, holding: 0, pnl: null, protected: null, heldMin: 0,
  lastRefusal: null, dislocation: emptyDislocation, ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  desks: [desk("INTCUSDT", { focused: true })], focus: "INTCUSDT",
  engine: { running: true, uptimeSec: 300, symbol: "INTCUSDT", symbols: ["INTCUSDT"] },
  mode: "testnet", hasCredentials: true,
  health: { level: "ok", tradeable: true, summary: "live", reasons: [] },
  market: { mid: 30.415, mark: 30.42, spreadBps: 3, lwi: 0.9, lwiBid: 0.8, lwiAsk: 1,
    warm: true, riskUp: 30, riskDown: 55, nearestAbove: 31, nearestBelow: 30,
    session: "regular", flow: { buy: 1, sell: 1 } },
  account: { at: Date.now(), error: null, availableBalance: 5000, walletBalance: 5000,
    unrealizedPnl: 0, marginRatio: 0.01, positions: [] },
  limits: { maxPositionUsd: 5000, maxLeverage: 20, maxDailyLossUsd: 200, maxOpenPositions: 1,
    tradingEnabled: false, stopLossPct: 0.2, maxTradesPerDay: 8, lossCooldownMin: 20,
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

const guiRender = (s: unknown) => { gui.render(s); return guiTitle; };

console.log("\n## the control GUI tab");
{
  // Mid, matching the "Mid" tile this mirrors — not the last trade the /sweep
  // page shows. The two surfaces headline different numbers, and a tab that
  // disagrees with the tile directly under it is worse than either choice.
  ok("shows the focused contract's mid", guiRender(status()) === "30.41 INTC", guiRender(status()));

  const armed = status({ limits: { ...status().limits, tradingEnabled: true } });
  ok("an armed session is marked", guiRender(armed) === "● 30.41 INTC", guiRender(armed));

  const blind = status({ health: { level: "blind", tradeable: false, summary: "no data", reasons: [] } });
  ok("an untradeable feed shows no price", guiRender(blind) === "INTC — no data", guiRender(blind));

  const armedBlind = status({
    health: { level: "blind", tradeable: false, summary: "no data", reasons: [] },
    limits: { ...status().limits, tradingEnabled: true },
  });
  ok("...and still says it is armed, which is the more urgent fact",
    guiRender(armedBlind) === "● INTC — no data", guiRender(armedBlind));

  const other = status({ focus: "BTCUSDT" });
  ok("it follows the focused desk, not the first one", guiRender(other).endsWith("BTC"), guiRender(other));

  const noMarket = status({ market: null });
  ok("no market data shows no price", guiRender(noMarket) === "INTC — no data", guiRender(noMarket));
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
