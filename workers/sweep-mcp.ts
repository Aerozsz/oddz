/**
 * The liquidity monitor, exposed to an agent over MCP.
 *
 * Run as a long-lived process:  npm run sweep:mcp
 *
 * This holds the same engine the dashboard runs — one combined Binance
 * WebSocket, a continuously maintained order book, the withdrawal
 * decomposition — and publishes it as MCP tools an agent can call. It reads
 * only. Nothing here can place an order, and no exchange credential is read or
 * required: every endpoint it touches is public market data.
 *
 * Two things about the transport, because getting either wrong is silent:
 *
 *  - stdout carries the JSON-RPC stream and nothing else. Every diagnostic goes
 *    to stderr. A stray console.log corrupts the protocol.
 *  - The engine needs to be warm before its numbers mean anything. The
 *    withdrawal baseline is an EWMA with a ten-minute half-life, so a tool call
 *    in the first seconds gets `health.level === "blind"` and later
 *    `"degraded"` until it settles. That is reported honestly rather than
 *    smoothed over — see the `health` field on every response.
 */

import { createInterface } from "node:readline";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import { directionalBias } from "../lib/sweep/agent/bias";
import { proposePosition } from "../lib/sweep/agent/sizing";
import type { Signal } from "../lib/sweep/agent";

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

const SERVER_NAME = "oddz-sweep";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const log = (...args: unknown[]) => console.error("[sweep-mcp]", ...args);

/* ------------------------------------------------------------------- engine */

let feed: SweepFeed | null = null;
const startedAt = Date.now();

function getFeed(): SweepFeed {
  if (!feed) {
    feed = createSweepFeed();
    feed.onSignal((s) => log(`signal ${s.kind} [${s.severity}] ${s.detail}`));
    log("engine started; warming up");
  }
  return feed;
}

/* -------------------------------------------------------------------- tools */

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

const noArgs = { type: "object", properties: {}, additionalProperties: false };

const TOOLS: Tool[] = [
  {
    name: "sweep_health",
    description:
      "Whether the market feed is currently fit to act on. Call this before anything else and " +
      "stop if `tradeable` is false: a stalled or desynced feed still returns plausible-looking " +
      "numbers (a stale book still has a mid price), so the other tools cannot tell you on their own " +
      "that they are wrong. `blind` means do not act. `degraded` means a sizing input is stale or " +
      "the depth baseline has not warmed up yet.",
    inputSchema: noArgs,
    run: () => {
      const s = getFeed().getState();
      return {
        ...s.health,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        note:
          s.health.level === "blind"
            ? "Do not trade on this. Market data is not trustworthy right now."
            : s.health.level === "degraded"
              ? "Readings are usable for context but a sizing input is stale or unwarmed."
              : "Feed is live and baselines are established.",
      };
    },
  },
  {
    name: "sweep_state",
    description:
      "Current market state for the Binance INTCUSDT perpetual: price, spread, the depth-withdrawal " +
      "index (depth now vs its own 10-minute baseline; below 1 is thinner than usual), the " +
      "withdrawn-vs-consumed split, cascade risk both directions, and the nearest trigger cluster " +
      "above and below. Always includes `health` — read it.",
    inputSchema: noArgs,
    run: () => getFeed().getState(),
  },
  {
    name: "sweep_signals",
    description:
      "Discrete events detected since the process started, newest first: depth withdrawn without " +
      "being traded through, a resting wall pulled, cascade risk crossing a threshold, price " +
      "approaching a trigger cluster, a burst of liquidations, and changes in feed health. These are " +
      "descriptive observations of order-book mechanics, not trade recommendations, and none of them " +
      "has been backtested.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max signals to return (default 20)." },
        kind: {
          type: "string",
          enum: ["withdrawal", "wall-pulled", "cascade-risk", "cluster-approach", "liquidation-burst", "health"],
          description: "Optional filter to one kind.",
        },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const all = getFeed().recentSignals(200);
      const filtered = typeof args.kind === "string" ? all.filter((s: Signal) => s.kind === args.kind) : all;
      return {
        health: getFeed().getState().health,
        count: filtered.length,
        signals: filtered.slice(0, limit),
      };
    },
  },
  {
    name: "sweep_levels",
    description:
      "Mapped trigger clusters around the current price — estimated stop and liquidation levels that " +
      "would push price further if reached, and resting depth that would absorb it. Sizes are MODELLED " +
      "from open interest, leverage tiers and prior structure; nobody publishes a book of stops. Treat " +
      "`confidence` seriously: levels sourced from 'observed' are ones where liquidations actually " +
      "printed, everything else is inference.",
    inputSchema: noArgs,
    run: () => {
      const s = getFeed().getState();
      return {
        health: s.health,
        mid: s.mid,
        nearestAbove: s.nearestAbove,
        nearestBelow: s.nearestBelow,
        cascadeUp: s.cascadeUp,
        cascadeDown: s.cascadeDown,
        caveat:
          "Cluster notionals are estimates, not observed orders. Cascade `terminal` assumes the whole " +
          "chain fires and that nobody re-quotes the book, which makes it an upper bound rather than " +
          "an expected price.",
      };
    },
  },
  {
    name: "sweep_behaviour",
    description:
      "What the book's behaviour suggests about who is trading it. Nothing here identifies anyone — it " +
      "measures fingerprints: how fast consumed depth is replaced, levels emptied and refilled repeatedly " +
      "(hidden size), quote churn without trades, and near-identical sizes at a steady rate (a worked " +
      "order). Also reports whether flow looks mechanical (computed sizes, tick pricing, even cadence) or " +
      "human (round prices, round quantities — unit bias), or both. Every reading has an innocent " +
      "explanation, so treat `confidence` as load-bearing.",
    inputSchema: noArgs,
    run: () => {
      const s = getFeed().getState();
      return { health: s.health, volatilityPct: s.volatilityPct, participants: s.participants };
    },
  },
  {
    name: "sweep_bias",
    description:
      "Which direction the book is more vulnerable in, with the factors behind it. IMPORTANT: this is " +
      "where price would travel IF it gets pushed — it is not a prediction that it will be. Nothing " +
      "measures intent. Conviction is capped at 0.75 and collapses when the feed is unhealthy or the " +
      "depth baseline has not warmed. A null direction means neither side is meaningfully more exposed.",
    inputSchema: noArgs,
    run: () => {
      const s = getFeed().getState();
      return { health: s.health, bias: directionalBias(s) };
    },
  },
  {
    name: "sweep_suggest_setup",
    description:
      "Proposes position size, leverage, stop and target for a direction, sized from the live book. " +
      "Returns numbers only — it applies nothing, changes no configuration and cannot place an order. " +
      "Refusal is a valid and common result: it declines when the feed is untrustworthy, the depth " +
      "baseline is cold, the reward does not justify the stop, or the caps are unset. Pass equity and " +
      "maxPositionUsd to model a hypothetical account.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "auto"], description: "'auto' uses sweep_bias." },
        equity: { type: "number", description: "Free collateral in USDT to size against." },
        maxPositionUsd: { type: "number", description: "Cap on notional." },
        maxLeverage: { type: "number" },
        stopLossPct: { type: "number" },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const feed = getFeed();
      const state = feed.getState();
      const bias = directionalBias(state);
      const asked = typeof args.direction === "string" ? args.direction : "auto";
      const chosen = asked === "auto" ? bias.direction : (asked as "up" | "down");
      if (!chosen) return { ok: false, bias, reasons: [bias.summary] };
      return {
        bias,
        result: proposePosition({
          direction: chosen,
          state,
          equity: Number(args.equity) || 0,
          realisedLossToday: 0,
          limits: {
            maxPositionUsd: Number(args.maxPositionUsd) || 0,
            maxLeverage: Number(args.maxLeverage) || 1,
            maxDailyLossUsd: 0,
            stopLossPct: Number(args.stopLossPct) || 2,
          },
          costCurve: feed.getCostCurve(),
          clusters: feed.getClusters(),
        }),
        appliedNothing: true,
      };
    },
  },
];

/* ---------------------------------------------------------------- transport */

type Id = string | number | null;

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: Id, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: Id, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg: Record<string, unknown>) {
  const id = (msg.id ?? null) as Id;
  const method = msg.method as string | undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and must never be answered.
  if (method === undefined) return;
  const isNotification = msg.id === undefined;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = typeof asked === "string" && SUPPORTED_PROTOCOLS.has(asked) ? asked : DEFAULT_PROTOCOL;
      // Start the engine here rather than at import, so the socket is only
      // opened once a client has actually attached.
      getFeed();
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Read-only monitor for the Binance INTCUSDT perpetual order book. Call sweep_health first — " +
          "if tradeable is false the other readings are not trustworthy, and they will not tell you so " +
          "themselves. All cluster and cascade figures are modelled estimates, not observed orders.",
      });
      return;
    }

    case "notifications/initialized":
    case "initialized":
      return;

    case "ping":
      if (!isNotification) reply(id, {});
      return;

    case "tools/list":
      reply(
        id,
        { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      );
      return;

    case "tools/call": {
      const name = params.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      try {
        const out = tool.run((params.arguments ?? {}) as Record<string, unknown>);
        reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        // Reported as a tool-level failure, not a protocol error, so the agent
        // sees it as a result it can reason about.
        reply(id, {
          content: [{ type: "text", text: `tool failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
      return;
    }

    // Declared unsupported rather than left to time out.
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;

    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
  }
}

/* --------------------------------------------------------------------- main */

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    replyError(null, -32700, "parse error");
    return;
  }
  try {
    handle(msg);
  } catch (err) {
    log("handler threw", err);
    replyError((msg.id ?? null) as Id, -32603, err instanceof Error ? err.message : String(err));
  }
});

rl.on("close", () => {
  feed?.close();
  process.exit(0);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    feed?.close();
    process.exit(0);
  });
}

log(`ready — ${TOOLS.length} tools, protocol ${DEFAULT_PROTOCOL}`);
