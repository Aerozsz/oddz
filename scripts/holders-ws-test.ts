/**
 * Verifies the WebSocket JSON-RPC transport against a mocked socket.
 *
 * The parts worth proving are the ones that fail silently in production: that
 * a batch frame is correlated back to the caller that sent it, that a single
 * request works too, that a timeout rejects instead of hanging forever, and
 * that a dropped connection fails in-flight callers rather than leaving them
 * waiting. None of that needs a real endpoint.
 *
 * Run: npx tsx scripts/holders-ws-test.ts
 */

import { WsTransport, httpTwin, isWsUrl } from "../lib/holders/ws";

type Listener = (ev: unknown) => void;

/** A WebSocket stand-in that answers JSON-RPC like a real node would. */
class MockSocket {
  static instances: MockSocket[] = [];
  static mode: "normal" | "silent" | "dropOnSend" = "normal";

  readyState = 0;
  private listeners = new Map<string, Listener[]>();
  sent: string[] = [];

  constructor(public url: string) {
    MockSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 1);
  }

  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(raw: string) {
    this.sent.push(raw);
    if (MockSocket.mode === "silent") return;
    if (MockSocket.mode === "dropOnSend") {
      setTimeout(() => {
        this.readyState = 3;
        this.emit("close", {});
      }, 1);
      return;
    }
    const req = JSON.parse(raw);
    const answer = (r: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: r.id,
      result: r.method === "eth_blockNumber" ? "0x2a" : `ok:${r.method}`,
    });
    const res = Array.isArray(req) ? req.map(answer) : answer(req);
    setTimeout(() => this.emit("message", { data: JSON.stringify(res) }), 1);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
}

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // --- URL helpers
  check("wss detected as websocket", isWsUrl("wss://robinhood.api.pocket.network"));
  check("https not detected as websocket", !isWsUrl("https://example.org"));
  check(
    "https twin derived from wss",
    httpTwin("wss://robinhood.api.pocket.network") === "https://robinhood.api.pocket.network",
    String(httpTwin("wss://robinhood.api.pocket.network")),
  );
  check("http url has no twin", httpTwin("https://example.org") === null);

  (globalThis as { WebSocket?: unknown }).WebSocket = MockSocket as unknown;

  // --- single request
  const t = new WsTransport("wss://fake.test", 2_000);
  const single = (await t.send({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })) as {
    id: number;
    result: string;
  };
  check("single request resolves", single?.result === "0x2a", JSON.stringify(single));

  // --- batch, correlated by the first id
  const batch = (await t.send([
    { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [] },
    { jsonrpc: "2.0", id: 3, method: "eth_call", params: [] },
  ])) as { id: number; result: string }[];
  check("batch resolves as an array", Array.isArray(batch) && batch.length === 2);
  check(
    "batch entries keep their ids",
    Array.isArray(batch) && batch[0].id === 2 && batch[1].id === 3,
    JSON.stringify(batch),
  );

  // --- connection reuse
  const before = MockSocket.instances.length;
  await t.send({ jsonrpc: "2.0", id: 4, method: "eth_chainId", params: [] });
  check(
    "connection reused across requests",
    MockSocket.instances.length === before,
    `${before} -> ${MockSocket.instances.length}`,
  );
  t.close();

  // --- a silent endpoint must time out, not hang
  MockSocket.mode = "silent";
  const t2 = new WsTransport("wss://silent.test", 300);
  const started = Date.now();
  let timedOut = false;
  try {
    await t2.send({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  } catch (err) {
    timedOut = String(err).includes("timed out");
  }
  check("silent endpoint times out", timedOut && Date.now() - started < 2_000);
  t2.close();

  // --- a drop must reject in-flight callers
  MockSocket.mode = "dropOnSend";
  const t3 = new WsTransport("wss://drop.test", 5_000);
  let rejected = false;
  try {
    await t3.send({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  } catch {
    rejected = true;
  }
  check("dropped connection rejects in-flight request", rejected);
  t3.close();

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
