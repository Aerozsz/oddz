/**
 * Local control plane for the sweep agent — HTTP API plus a GUI.
 *
 *   npm run sweep:control
 *
 * Binds to 127.0.0.1 only and requires a token printed at startup. This process
 * reads exchange credentials and will eventually place orders, so it is never
 * to be exposed to a network or deployed anywhere. It is a local operator
 * console, not a web service.
 *
 * What it can do today: run and stop the monitor, show feed health, market
 * state and live signals, read the exchange position and margin, and store the
 * risk limits that order execution will be bound by. Order placement is not
 * wired up yet and the GUI says so rather than offering a button that lies.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import type { Signal } from "../lib/sweep/agent";
import {
  fetchAccountRisk,
  hasCredentials,
  loadConfig,
  redact,
  type AccountRisk,
} from "../lib/sweep/exchange/binance";
import { previewPosition } from "../lib/sweep/exchange/preview";
import { proposePosition } from "../lib/sweep/agent/sizing";
import { directionalBias } from "../lib/sweep/agent/bias";
import { checkProtection, ensureProtected, type ProtectionState } from "../lib/sweep/exchange/orders";
import { fetchPosition } from "../lib/sweep/exchange/binance";
import { CONFIG, SYMBOL } from "../lib/sweep/config";

/*
 * Node 22 or newer. The engine uses the global WebSocket, which older releases
 * do not provide — without this check that surfaces as "WebSocket is not
 * defined" deep inside a stream callback, which is a miserable first
 * experience for something that is really just a version mismatch.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error("");
  console.error(`  This needs Node 22 or newer. You are on ${process.versions.node}.`);
  console.error("  Install the current LTS from https://nodejs.org and run this again.");
  console.error("");
  process.exit(1);
}

const PORT = Number(process.env.SWEEP_CONTROL_PORT ?? 7777);
/*
 * Loopback by default. This process holds an exchange secret and can move a
 * position, so it is not something to put on a network casually — binding wider
 * is an explicit choice, and the safe way to reach it from elsewhere is a
 * tunnel (Cloudflare Tunnel, Tailscale) that authenticates before traffic ever
 * arrives here, rather than opening a port and relying on the token alone.
 */
const HOST = process.env.SWEEP_CONTROL_HOST ?? "127.0.0.1";
const TOKEN = process.env.SWEEP_CONTROL_TOKEN ?? randomBytes(16).toString("hex");
const LIMITS_PATH = resolve(process.env.SWEEP_LIMITS ?? "data/sweep-limits.json");

const log = (...a: unknown[]) => console.log("[control]", ...a.map((x) => (typeof x === "string" ? redact(x) : x)));

/* -------------------------------------------------------------------- state */

interface Limits {
  maxPositionUsd: number;
  maxLeverage: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  /** Nothing may be submitted while this is false. Defaults off. */
  tradingEnabled: boolean;
  /**
   * How far from the mark the protective stop sits, in percent. Every position
   * gets one on the exchange; this is the only tunable part of that.
   */
  stopLossPct: number;
}

const DEFAULT_LIMITS: Limits = {
  maxPositionUsd: 0,
  maxLeverage: 1,
  maxDailyLossUsd: 0,
  maxOpenPositions: 1,
  tradingEnabled: false,
  stopLossPct: 2,
};

function readLimits(): Limits {
  if (!existsSync(LIMITS_PATH)) return { ...DEFAULT_LIMITS };
  try {
    return { ...DEFAULT_LIMITS, ...JSON.parse(readFileSync(LIMITS_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

function writeLimits(next: Limits) {
  mkdirSync(dirname(LIMITS_PATH), { recursive: true });
  writeFileSync(LIMITS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

let feed: SweepFeed | null = null;
let startedAt = 0;
let account: { risk: AccountRisk | null; error: string | null; at: number } = {
  risk: null,
  error: null,
  at: 0,
};
let limits = readLimits();

function startEngine() {
  if (feed) return;
  feed = createSweepFeed();
  startedAt = Date.now();
  log("engine started");
}

function stopEngine() {
  if (!feed) return;
  feed.close();
  feed = null;
  startedAt = 0;
  log("engine stopped");
}

let protection: { state: ProtectionState | null; error: string | null; at: number } = {
  state: null,
  error: null,
  at: 0,
};

async function refreshAccount() {
  if (!hasCredentials()) {
    account = { risk: null, error: "no credentials configured", at: Date.now() };
    protection = { state: null, error: null, at: Date.now() };
    return;
  }
  try {
    const cfg = loadConfig();
    account = { risk: await fetchAccountRisk(cfg), error: null, at: Date.now() };
    const position = await fetchPosition(cfg, SYMBOL);
    protection = { state: await checkProtection(cfg, SYMBOL, position), error: null, at: Date.now() };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    account = { risk: null, error: message, at: Date.now() };
    protection = { state: null, error: message, at: Date.now() };
  }
}

/**
 * Startup reconciliation.
 *
 * A position can outlive this process — that is the whole point of leaving it
 * in place rather than closing on exit — so the first thing a new run does is
 * ask the exchange what is open and whether a stop is resting against it. A
 * position found unprotected is covered immediately rather than reported and
 * left, because the window where it is uncovered is the risk.
 */
async function reconcileOnStart() {
  if (!hasCredentials()) return;
  try {
    const cfg = loadConfig();
    const position = await fetchPosition(cfg, SYMBOL);
    if (!position) {
      log("startup: flat, nothing to reconcile");
      return;
    }
    log(`startup: found an open position of ${position.positionAmt} ${SYMBOL}`);
    const before = await checkProtection(cfg, SYMBOL, position);
    if (before.protected) {
      log(`startup: ${before.reason}`);
      protection = { state: before, error: null, at: Date.now() };
      return;
    }
    log(`startup: ${before.reason} — placing one now`);
    const after = await ensureProtected(cfg, SYMBOL, position, limits.stopLossPct, 2);
    log(`startup: ${after.reason}`);
    protection = { state: after, error: null, at: Date.now() };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    log(`startup reconciliation FAILED: ${message}`);
    protection = { state: null, error: message, at: Date.now() };
  }
}

function status() {
  const state = feed?.getState() ?? null;
  const creds = hasCredentials();
  let mode: "none" | "testnet" | "live" = "none";
  if (creds) mode = process.env.BINANCE_LIVE === "1" ? "live" : "testnet";

  return {
    engine: {
      running: feed !== null,
      uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
      symbol: SYMBOL,
    },
    mode,
    hasCredentials: creds,
    health: state?.health ?? null,
    market: state
      ? {
          mid: state.mid,
          mark: state.mark,
          spreadBps: state.liquidity?.spreadBps ?? null,
          lwi: state.liquidity?.lwi ?? null,
          lwiBid: state.liquidity?.lwiBid ?? null,
          lwiAsk: state.liquidity?.lwiAsk ?? null,
          warm: state.liquidity?.warm ?? null,
          riskUp: state.cascadeUp?.risk ?? null,
          riskDown: state.cascadeDown?.risk ?? null,
          nearestAbove: state.nearestAbove?.price ?? null,
          nearestBelow: state.nearestBelow?.price ?? null,
          session: state.session.phase,
          flow: state.flow,
        }
      : null,
    account: {
      at: account.at,
      error: account.error,
      availableBalance: account.risk?.availableBalance ?? null,
      walletBalance: account.risk?.walletBalance ?? null,
      unrealizedPnl: account.risk?.totalUnrealizedPnl ?? null,
      marginRatio: account.risk?.marginRatio ?? null,
      positions:
        account.risk?.openPositions.map((p) => ({
          symbol: p.symbol,
          amt: p.positionAmt,
          entry: p.entryPrice,
          mark: p.markPrice,
          pnl: p.unrealizedPnl,
          liquidation: p.liquidationPrice,
          leverage: p.leverage,
          notional: p.notional,
        })) ?? [],
    },
    limits,
    protection: {
      at: protection.at,
      error: protection.error,
      flat: protection.state ? protection.state.position === null : null,
      protected: protection.state?.protected ?? null,
      stopPrice: protection.state?.stop?.stopPrice ?? null,
      stopDistancePct: protection.state?.stopDistancePct ?? null,
      reason: protection.state?.reason ?? null,
    },
    // Stated rather than implied, so the GUI never suggests a capability the
    // process does not have.
    execution: {
      available: false,
      reason: "order placement is not implemented yet — read-only until risk limits are set and reviewed",
    },
  };
}

/* ----------------------------------------------------------------- http api */

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": type,
    // A local console has no business being framed, cached or referred out.
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

function authorised(req: IncomingMessage, url: URL): boolean {
  const header = req.headers["x-control-token"];
  const supplied = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("token") ?? "";
  // Length-independent compare is overkill on loopback, but the token is the
  // only thing standing between another local process and this API.
  if (supplied.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= supplied.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (!authorised(req, url)) {
    send(res, 401, { error: "bad or missing token", hint: "open the URL printed by the server" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(res, 200, html(TOKEN), "text/html; charset=utf-8");
    return;
  }

  try {
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/status":
        send(res, 200, status());
        return;

      case "GET /api/signals": {
        const limit = Number(url.searchParams.get("limit") ?? 40);
        send(res, 200, { signals: feed?.recentSignals(limit) ?? [] });
        return;
      }

      case "POST /api/engine/start":
        startEngine();
        send(res, 200, status());
        return;

      case "POST /api/engine/stop":
        stopEngine();
        send(res, 200, status());
        return;

      case "POST /api/account/refresh":
        await refreshAccount();
        send(res, 200, status());
        return;

      case "POST /api/limits": {
        const body = await readJson(req);
        const n = (k: string, fallback: number) => {
          const v = Number(body[k]);
          return Number.isFinite(v) && v >= 0 ? v : fallback;
        };
        limits = {
          maxPositionUsd: n("maxPositionUsd", limits.maxPositionUsd),
          maxLeverage: Math.max(1, n("maxLeverage", limits.maxLeverage)),
          maxDailyLossUsd: n("maxDailyLossUsd", limits.maxDailyLossUsd),
          maxOpenPositions: Math.max(0, Math.round(n("maxOpenPositions", limits.maxOpenPositions))),
          tradingEnabled: body.tradingEnabled === true,
          stopLossPct: Math.max(0.1, n("stopLossPct", limits.stopLossPct)),
        };
        writeLimits(limits);
        log(`limits updated: ${JSON.stringify(limits)}`);
        send(res, 200, status());
        return;
      }

      case "POST /api/suggest": {
        // Computes numbers and returns them. It does not apply anything, does
        // not touch the stored limits, and cannot place an order — the operator
        // reads the reasoning and decides what the caps should be.
        const body = await readJson(req);
        const state = feed?.getState() ?? null;
        if (!state) { send(res, 200, { error: "engine is not running" }); return; }
        const bias = directionalBias(state);
        // "auto" hands the choice to the bias read; an explicit side overrides it.
        const chosen =
          body.direction === "auto" || body.direction === undefined
            ? bias.direction
            : body.direction === "down"
              ? "down"
              : "up";
        if (!chosen) {
          send(res, 200, { result: { ok: false, reasons: [bias.summary] }, bias, participants: state.participants, volatilityPct: state.volatilityPct, appliedNothing: true });
          return;
        }
        const result = proposePosition({
          direction: chosen,
          state,
          equity: account.risk?.availableBalance ?? Number(body.assumeEquity) ?? 0,
          realisedLossToday: 0,
          limits: {
            maxPositionUsd: limits.maxPositionUsd > 0 ? limits.maxPositionUsd : Number(body.assumeMaxPositionUsd) || 0,
            maxLeverage: limits.maxLeverage,
            maxDailyLossUsd: limits.maxDailyLossUsd,
            stopLossPct: limits.stopLossPct,
          },
          costCurve: feed ? feed.getCostCurve() : [],
          clusters: feed ? feed.getClusters() : [],
        });
        send(res, 200, {
          result,
          bias,
          participants: state.participants,
          volatilityPct: state.volatilityPct,
          appliedNothing: true,
        });
        return;
      }

      case "POST /api/preview": {
        const body = await readJson(req);
        const state = feed?.getState() ?? null;
        const entry = Number(body.entryPrice) || state?.mark || state?.mid || 0;
        if (!entry) {
          send(res, 200, { error: "no price available yet — start the engine and wait for the book" });
          return;
        }
        const raw = feed ? feed.getClusters() : [];
        const preview = previewPosition({
          side: body.side === "short" ? "short" : "long",
          notionalUsd: Math.max(0, Number(body.notionalUsd) || 0),
          leverage: Math.max(1, Number(body.leverage) || 1),
          entryPrice: entry,
          availableBalance: account.risk?.availableBalance ?? 0,
          maintMarginRate: Number(body.maintMarginRate) || CONFIG.maintenanceMarginRate,
          takerFeeRate: Number(body.takerFeeRate) || 0.0005,
          makerFeeRate: Number(body.makerFeeRate) || 0.0002,
          stepSize: 0.001,
          pricePrecision: 2,
          clusters: raw,
        });
        // Checked against the limits already stored, so the preview says
        // whether this position would be allowed, not merely what it costs.
        const breaches: string[] = [];
        if (limits.maxPositionUsd > 0 && preview.notional > limits.maxPositionUsd) {
          breaches.push(`notional ${preview.notional.toFixed(0)} exceeds max ${limits.maxPositionUsd}`);
        }
        if (preview.leverage > limits.maxLeverage) {
          breaches.push(`leverage ${preview.leverage}x exceeds max ${limits.maxLeverage}x`);
        }
        if ((account.risk?.openPositions.length ?? 0) >= limits.maxOpenPositions) {
          breaches.push(`already at max open positions (${limits.maxOpenPositions})`);
        }
        send(res, 200, { preview, breaches, usedEntry: entry, accountKnown: account.risk !== null });
        return;
      }

      case "POST /api/protect": {
        if (!hasCredentials()) { send(res, 200, { error: "no credentials configured" }); return; }
        const cfg = loadConfig();
        const position = await fetchPosition(cfg, SYMBOL);
        const state = await ensureProtected(cfg, SYMBOL, position, limits.stopLossPct, 2);
        protection = { state, error: null, at: Date.now() };
        log(`manual protect: ${state.reason}`);
        send(res, 200, status());
        return;
      }

      case "POST /api/kill": {
        // The stop-everything control. Today that means killing the feed and
        // disarming trading; once orders exist it also cancels and flattens.
        limits = { ...limits, tradingEnabled: false };
        writeLimits(limits);
        stopEngine();
        log("KILL: engine stopped, trading disarmed");
        send(res, 200, { ...status(), killed: true });
        return;
      }

      default:
        send(res, 404, { error: "not found" });
    }
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    log("request failed:", message);
    send(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  startEngine();
  void (async () => {
    await reconcileOnStart();
    await refreshAccount();
  })();
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log("");
  console.log("  Sweep agent control");
  console.log(`  ${url}`);
  console.log("");
  console.log(`  mode:        ${hasCredentials() ? (process.env.BINANCE_LIVE === "1" ? "LIVE" : "testnet") : "no credentials (monitor only)"}`);
  if (HOST !== "127.0.0.1") {
    console.log("");
    console.log(`  !! bound to ${HOST}, not loopback — this port can move money.`);
    console.log("     Only do this behind a tunnel that authenticates before traffic reaches here.");
  }
  console.log(`  limits file: ${LIMITS_PATH}`);
  console.log("  ctrl-c to stop");
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopEngine();
    server.close();
    // Positions are deliberately left open: their protection is the stop
    // resting on the exchange, which outlives this process.
    console.log("");
    console.log("  Stopped. Any open position is LEFT OPEN by design —");
    console.log("  its stop-loss is on Binance and keeps working while this is off.");
    console.log("  Restarting re-checks the position and replaces the stop if it is missing.");
    console.log("");
    process.exit(0);
  });
}

/* -------------------------------------------------------------------- gui */

function html(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sweep agent control</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--plane:#0d0d0d;--surface:#141413;--surface2:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--hair:rgba(255,255,255,.1);--good:#0ca30c;--warn:#fab219;--bad:#d03b3b;--liq:#3987e5;--forced:#d95926;--r:6px}
*{box-sizing:border-box}body{margin:0;background:var(--plane);color:var(--ink);
font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--surface);
border:1px solid var(--hair);border-radius:var(--r);padding:12px 16px}
.bar b{font-size:15px}
.mode{padding:3px 10px;border-radius:999px;font-size:11px;border:1px solid var(--hair);white-space:nowrap}
.mode.live{background:rgba(208,59,59,.15);border-color:var(--bad);color:#ff8a8a;font-weight:600}
.mode.testnet{background:rgba(57,135,229,.12);border-color:var(--liq);color:#8fc0ff}
.mode.none{color:var(--muted)}
.grid{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:960px){.grid{grid-template-columns:1fr 1fr}}
.panel{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r);padding:12px 14px 14px}
.panel h2{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2)}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--hair);
border:1px solid var(--hair);border-radius:var(--r);overflow:hidden}
.tile{background:var(--surface);padding:9px 11px;display:flex;flex-direction:column;gap:2px}
.k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.d{font-size:11px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.dot.ok{background:var(--good)}.dot.degraded{background:var(--warn)}.dot.blind{background:var(--bad)}
button{background:var(--surface2);color:var(--ink);border:1px solid var(--hair);border-radius:var(--r);
padding:7px 13px;font:inherit;cursor:pointer}
button:hover:not(:disabled){border-color:var(--liq)}
button:disabled{opacity:.4;cursor:not-allowed}
button.danger{border-color:var(--bad);color:#ff9c9c}
button.danger:hover:not(:disabled){background:rgba(208,59,59,.15)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:right;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
font-weight:500;padding:4px 6px;border-bottom:1px solid #2c2c2a}
th:first-child,td:first-child{text-align:left}
td{text-align:right;padding:4px 6px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04)}
.sig{max-height:340px;overflow-y:auto}
.sig .item{padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;gap:8px;align-items:baseline}
.sev{font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex:none;width:58px}
.sev.info{color:var(--muted)}.sev.warning{color:var(--warn)}.sev.critical{color:var(--bad)}
.muted{color:var(--muted)}
.note{font-size:11px;color:var(--muted);margin:8px 0 0}
label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--muted)}
input{background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);
padding:6px 8px;font:inherit;font-variant-numeric:tabular-nums;width:100%}
.banner{display:flex;gap:10px;padding:10px 12px;border-radius:var(--r);border:1px solid;align-items:flex-start}
.banner.bad{background:rgba(208,59,59,.1);border-color:rgba(208,59,59,.5)}
.banner.warn{background:rgba(250,178,25,.08);border-color:rgba(250,178,25,.45)}
</style></head><body><div class="wrap">

<div class="bar">
  <b>Sweep agent</b>
  <span id="mode" class="mode none">—</span>
  <span class="row" style="gap:6px"><i id="hdot" class="dot blind"></i><span id="health" class="muted">connecting…</span></span>
  <span class="muted" id="uptime"></span>
  <span style="flex:1"></span>
  <button id="btnStart">Start</button>
  <button id="btnStop">Stop</button>
  <button id="btnRefresh">Refresh account</button>
  <button id="btnKill" class="danger">Kill</button>
</div>

<div id="protNote"></div>
<div id="execNote"></div>

<div class="grid">
  <div class="panel">
    <h2>Market</h2>
    <div class="tiles">
      <div class="tile"><span class="k">Mid</span><span class="v" id="mid">—</span><span class="d" id="session">—</span></div>
      <div class="tile"><span class="k">Depth index</span><span class="v" id="lwi">—</span><span class="d" id="lwiSides">bid / ask</span></div>
      <div class="tile"><span class="k">Cascade ↓</span><span class="v" id="riskDown">—</span><span class="d" id="below">—</span></div>
      <div class="tile"><span class="k">Cascade ↑</span><span class="v" id="riskUp">—</span><span class="d" id="above">—</span></div>
    </div>
    <p class="note" id="healthNote"></p>
  </div>

  <div class="panel">
    <h2>Position &amp; risk</h2>
    <div class="tiles">
      <div class="tile"><span class="k">Available</span><span class="v" id="avail">—</span><span class="d">USDT</span></div>
      <div class="tile"><span class="k">Unrealised</span><span class="v" id="upnl">—</span><span class="d">open PnL</span></div>
      <div class="tile"><span class="k">Margin ratio</span><span class="v" id="mratio">—</span><span class="d">maint / balance</span></div>
      <div class="tile"><span class="k">Open</span><span class="v" id="npos">—</span><span class="d">positions</span></div>
    </div>
    <table style="margin-top:10px"><thead><tr><th>Symbol</th><th>Size</th><th>Entry</th><th>Liq.</th><th>PnL</th></tr></thead>
    <tbody id="positions"><tr><td colspan="5" class="muted">no account data</td></tr></tbody></table>
    <p class="note" id="acctNote"></p>
  </div>
</div>

<div class="panel">
  <h2>Risk limits</h2>
  <div class="row" style="gap:12px;align-items:flex-end">
    <label style="width:150px">Max position (USD)<input id="maxPositionUsd" type="number" min="0" step="10"></label>
    <label style="width:110px">Max leverage<input id="maxLeverage" type="number" min="1" max="10" step="1"></label>
    <label style="width:150px">Max daily loss (USD)<input id="maxDailyLossUsd" type="number" min="0" step="10"></label>
    <label style="width:130px">Max open positions<input id="maxOpenPositions" type="number" min="0" step="1"></label>
    <label style="width:140px">Stop-loss distance (%)<input id="stopLossPct" type="number" min="0.1" step="0.1"></label>
    <label style="width:130px">Trading armed<select id="tradingEnabled" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="false">disarmed</option><option value="true">armed</option></select></label>
    <button id="btnLimits">Save limits</button>
  </div>
  <p class="note">Stored on this machine and enforced by the execution layer when it lands. Armed does nothing until then.
  Every position gets a stop-loss placed <b>on Binance</b> — it keeps working when this program is closed.</p>
</div>

<div class="panel">
  <h2>Position preview — before anything is sent</h2>
  <div class="row" style="gap:12px;align-items:flex-end">
    <label style="width:110px">Side<select id="pvSide" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="long">long</option><option value="short">short</option></select></label>
    <label style="width:150px">Size (USD)<input id="pvNotional" type="number" min="0" step="50" value="1000"></label>
    <label style="width:110px">Leverage<input id="pvLeverage" type="number" min="1" max="10" step="1" value="2"></label>
    <label style="width:150px">Entry (blank = mark)<input id="pvEntry" type="number" step="0.01" placeholder="mark"></label>
    <button id="btnPreview">Preview</button>
  </div>
  <div id="pvOut" style="margin-top:12px"><span class="muted">Enter a size and press Preview.</span></div>
  <div class="row" style="margin-top:12px;gap:8px;align-items:center;border-top:1px solid var(--hair);padding-top:12px">
    <b style="font-size:12px">Suggest numbers</b>
    <select id="sgDir" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="auto">let it decide</option><option value="up">upside</option><option value="down">downside</option></select>
    <button id="btnSuggest">Work out a setup</button>
    <span class="muted" style="font-size:11px">reads the live book and proposes size, stop and target — applies nothing</span>
  </div>
  <div id="sgOut" style="margin-top:10px"></div>
</div>

<div class="panel">
  <h2>Signals</h2>
  <div class="sig" id="signals"><div class="muted">none yet</div></div>
</div>

</div><script>
const TOKEN=${JSON.stringify(token)};
const api=(p,o={})=>fetch(p,{...o,headers:{"x-control-token":TOKEN,"content-type":"application/json"}}).then(r=>r.json());
const $=id=>document.getElementById(id);
const n=(v,d=2)=>v===null||v===undefined||!isFinite(v)?"—":Number(v).toFixed(d);
const usd=v=>v===null||v===undefined||!isFinite(v)?"—":(Math.abs(v)>=1e6?"$"+(v/1e6).toFixed(2)+"M":Math.abs(v)>=1e3?"$"+(v/1e3).toFixed(1)+"k":"$"+v.toFixed(2));

let limitsDirty=false;
for(const id of ["maxPositionUsd","maxLeverage","maxDailyLossUsd","maxOpenPositions","stopLossPct"]) $(id).addEventListener("input",()=>limitsDirty=true);
$("tradingEnabled").addEventListener("change",()=>limitsDirty=true);

function render(s){
  $("mode").className="mode "+s.mode;
  $("mode").textContent=s.mode==="live"?"LIVE — real money":s.mode==="testnet"?"testnet":"no credentials";
  const h=s.health;
  $("hdot").className="dot "+(h?h.level:"blind");
  $("health").textContent=h?(h.tradeable?"tradeable":h.level):"stopped";
  $("healthNote").textContent=h?h.summary:"";
  $("uptime").textContent=s.engine.running?s.engine.uptimeSec+"s up · "+s.engine.symbol:"stopped";
  $("btnStart").disabled=s.engine.running; $("btnStop").disabled=!s.engine.running;

  const pr=s.protection;
  $("protNote").innerHTML =
    pr.error ? '<div class="banner warn"><b>Cannot check protection.</b><span>'+pr.error+'</span></div>'
    : pr.protected===false ? '<div class="banner bad"><b>OPEN POSITION WITH NO STOP-LOSS.</b><span>'+
        'Nothing will close this if price runs against you except liquidation. '+
        '<button id="btnProtect" style="margin-left:8px">Place stop now</button></span></div>'
    : pr.protected===true && pr.flat===false ? '<div class="banner warn"><span>Position protected — '+pr.reason+'</span></div>'
    : "";
  const bp=document.getElementById("btnProtect");
  if(bp) bp.onclick=async()=>render(await api("/api/protect",{method:"POST"}));

  $("execNote").innerHTML=s.execution.available?"":
    '<div class="banner warn"><b>Read-only.</b><span>'+s.execution.reason+'</span></div>';

  const m=s.market;
  $("mid").textContent=m?n(m.mid):"—";
  $("session").textContent=m?"Nasdaq "+m.session:"—";
  $("lwi").textContent=m?n(m.lwi,2):"—";
  $("lwiSides").textContent=m?(m.warm?"":"cold · ")+"bid "+n(m.lwiBid,2)+" / ask "+n(m.lwiAsk,2):"—";
  $("riskDown").textContent=m&&m.riskDown!==null?n(m.riskDown,0):"—";
  $("riskUp").textContent=m&&m.riskUp!==null?n(m.riskUp,0):"—";
  $("below").textContent=m&&m.nearestBelow?"→ "+n(m.nearestBelow):"no level below";
  $("above").textContent=m&&m.nearestAbove?"→ "+n(m.nearestAbove):"no level above";

  const a=s.account;
  $("avail").textContent=usd(a.availableBalance);
  $("upnl").textContent=usd(a.unrealizedPnl);
  $("mratio").textContent=a.marginRatio===null?"—":(a.marginRatio*100).toFixed(1)+"%";
  $("npos").textContent=a.positions.length;
  $("acctNote").textContent=a.error?("account: "+a.error):(a.at?"updated "+new Date(a.at).toLocaleTimeString():"");
  $("positions").innerHTML=a.positions.length?a.positions.map(p=>
    "<tr><td>"+p.symbol+"</td><td>"+n(p.amt,3)+"</td><td>"+n(p.entry)+"</td><td>"+n(p.liquidation)+"</td><td>"+usd(p.pnl)+"</td></tr>").join("")
    :'<tr><td colspan="5" class="muted">'+(a.error?"unavailable":"flat")+"</td></tr>";

  if(!limitsDirty){
    $("maxPositionUsd").value=s.limits.maxPositionUsd;
    $("maxLeverage").value=s.limits.maxLeverage;
    $("maxDailyLossUsd").value=s.limits.maxDailyLossUsd;
    $("maxOpenPositions").value=s.limits.maxOpenPositions;
    $("tradingEnabled").value=String(s.limits.tradingEnabled);
    $("stopLossPct").value=s.limits.stopLossPct;
  }
}

async function tick(){
  try{
    render(await api("/api/status"));
    const {signals}=await api("/api/signals?limit=40");
    $("signals").innerHTML=signals.length?signals.map(x=>
      '<div class="item"><span class="sev '+x.severity+'">'+x.severity+'</span>'+
      '<span class="muted" style="flex:none;width:64px">'+new Date(x.t).toLocaleTimeString()+'</span>'+
      "<span>"+x.detail.replace(/</g,"&lt;")+"</span></div>").join(""):'<div class="muted">none yet</div>';
  }catch(e){ $("health").textContent="control server unreachable"; }
}

$("btnStart").onclick=async()=>render(await api("/api/engine/start",{method:"POST"}));
$("btnStop").onclick=async()=>render(await api("/api/engine/stop",{method:"POST"}));
$("btnRefresh").onclick=async()=>render(await api("/api/account/refresh",{method:"POST"}));
$("btnKill").onclick=async()=>{ if(confirm("Stop the engine and disarm trading?")) render(await api("/api/kill",{method:"POST"})); };
$("btnLimits").onclick=async()=>{
  const body={maxPositionUsd:+$("maxPositionUsd").value,maxLeverage:+$("maxLeverage").value,
    maxDailyLossUsd:+$("maxDailyLossUsd").value,maxOpenPositions:+$("maxOpenPositions").value,
    tradingEnabled:$("tradingEnabled").value==="true",stopLossPct:+$("stopLossPct").value};
  limitsDirty=false; render(await api("/api/limits",{method:"POST",body:JSON.stringify(body)}));
};

$("btnPreview").onclick=async()=>{
  const body={side:$("pvSide").value,notionalUsd:+$("pvNotional").value,
    leverage:+$("pvLeverage").value,entryPrice:$("pvEntry").value?+$("pvEntry").value:undefined};
  const r=await api("/api/preview",{method:"POST",body:JSON.stringify(body)});
  if(r.error){ $("pvOut").innerHTML='<div class="banner warn"><span>'+r.error+"</span></div>"; return; }
  const p=r.preview, sev={info:"warn",warning:"warn",critical:"bad"};
  const banners=[
    ...(r.breaches||[]).map(b=>'<div class="banner bad"><b>Blocked by your limits.</b><span>'+b+"</span></div>"),
    ...p.warnings.map(w=>'<div class="banner '+sev[w.level]+'"><span>'+w.message+"</span></div>"),
  ].join("");
  $("pvOut").innerHTML=
    '<div class="tiles">'+
    '<div class="tile"><span class="k">Size</span><span class="v">'+n(p.qty,3)+'</span><span class="d">'+usd(p.notional)+" notional</span></div>"+
    '<div class="tile"><span class="k">Margin required</span><span class="v">'+usd(p.initialMargin)+'</span><span class="d">at '+p.leverage+"x</span></div>"+
    '<div class="tile"><span class="k">Liquidation</span><span class="v">'+n(p.liquidationPrice)+'</span><span class="d">'+n(p.liqDistancePct,2)+"% away · estimate</span></div>"+
    '<div class="tile"><span class="k">Round-trip fee</span><span class="v">'+usd(p.roundTripFeeTaker)+'</span><span class="d">needs +'+n(p.breakevenMovePct,3)+"% to break even</span></div>"+
    "</div>"+
    '<p class="note">Entry '+n(r.usedEntry)+" · balance after "+usd(p.balanceAfter)+
    (r.accountKnown?"":" · no account data, balance assumed 0")+
    " · maker entry would cost "+usd(p.entryFeeMaker)+" instead of "+usd(p.entryFeeTaker)+"</p>"+
    (banners?'<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">'+banners+"</div>":"")+
    '<p class="note">Liquidation price is an estimate assuming isolated margin and a '+
    "modelled maintenance rate; Binance's own figure is authoritative and accounts for the notional tier, funding and cross-margin wallet.</p>";
};

$("btnSuggest").onclick=async()=>{
  const r=await api("/api/suggest",{method:"POST",body:JSON.stringify({direction:$("sgDir").value})});
  if(r.error){ $("sgOut").innerHTML='<div class="banner warn"><span>'+r.error+"</span></div>"; return; }
  const res=r.result;
  const b=r.bias;
  const biasHtml=b?('<div class="banner '+(b.direction?"warn":"")+'" style="margin-bottom:8px"><div>'+
    "<b>"+(b.direction?("Least resistance: "+(b.direction==="down"?"downward":"upward")+" · "+Math.round(b.conviction*100)+"% conviction"):"No clear side")+"</b>"+
    '<div class="sub" style="margin-top:3px">'+b.summary.replace(/</g,"&lt;")+"</div>"+
    '<div class="sub" style="margin-top:4px;opacity:.8">'+b.factors.map(f=>f.name+": "+f.detail).join(" · ").replace(/</g,"&lt;")+"</div>"+
    '<div class="sub" style="margin-top:4px;opacity:.7">'+b.caveat+"</div>"+
    "</div></div>"):"";
  const beh=r.participants?('<p class="note">Book behaviour: <b>'+r.participants.regime+"</b> ("+
    Math.round(r.participants.confidence*100)+"% confidence) — "+(r.participants.notes[0]||"")+
    " · recent movement "+n(r.volatilityPct,2)+"%/min</p>"):"";
  if(!res.ok){
    $("sgOut").innerHTML=biasHtml+'<div class="banner warn"><b>No setup worth taking.</b><span>'+
      res.reasons.join("; ")+"</span></div>"+beh;
    return;
  }
  $("sgOut").innerHTML=biasHtml+beh+
    '<div class="tiles" style="margin-top:8px">'+
    '<div class="tile"><span class="k">Suggested size</span><span class="v">'+usd(res.notionalUsd)+'</span><span class="d">'+n(res.quantity,3)+" contracts</span></div>"+
    '<div class="tile"><span class="k">Leverage</span><span class="v">'+res.leverage+'x</span><span class="d">'+usd(res.marginUsd)+" margin</span></div>"+
    '<div class="tile"><span class="k">Stop</span><span class="v">'+n(res.stopPrice)+'</span><span class="d">'+n(res.stopDistancePct,2)+"% · risks "+usd(res.riskUsd)+"</span></div>"+
    '<div class="tile"><span class="k">Target</span><span class="v">'+(res.targetPrice?n(res.targetPrice):"—")+'</span><span class="d">'+
      (res.rewardRisk?n(res.rewardRisk,2)+":1 reward:risk":"no level ahead")+"</span></div>"+
    "</div>"+
    '<p class="note"><b>Why:</b> '+res.reasoning.map(x=>x.replace(/</g,"&lt;")).join(" · ")+"</p>"+
    '<div class="row" style="margin-top:8px"><button id="btnCopy">Copy into preview</button>'+
    '<span class="muted" style="font-size:11px">nothing has been applied or ordered — these are numbers for you to judge</span></div>';
  document.getElementById("btnCopy").onclick=()=>{
    $("pvSide").value=res.side; $("pvNotional").value=Math.round(res.notionalUsd);
    $("pvLeverage").value=res.leverage; $("pvEntry").value=res.entryPrice.toFixed(2);
    $("btnPreview").click();
  };
};

tick(); setInterval(tick,1000);
</script></body></html>`;
}
