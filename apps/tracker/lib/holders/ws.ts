import { log } from "@/lib/logger";

/**
 * JSON-RPC over WebSocket.
 *
 * Needed because many chain RPC providers publish a `wss://` endpoint and no
 * HTTP one. Node 22 ships a global WebSocket, so this adds no dependency.
 *
 * One connection is shared by every request in the process and requests are
 * correlated by id, so a batch of 25 `eth_getCode` calls costs one round trip
 * rather than 25 connections. In a serverless runtime the connection lives as
 * long as the warm instance does and is re-established transparently after a
 * cold start or a drop.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async connect(): Promise<WebSocket> {
    const existing = this.socket;
    if (existing && existing.readyState === 1 /* OPEN */) return existing;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        reject(new Error("WebSocket is not available in this runtime"));
        return;
      }
      let settled = false;
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Already closing.
        }
        reject(new Error(`websocket connect timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = ws;
        resolve(ws);
      });

      ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));

      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("websocket error during connect"));
        }
      });

      ws.addEventListener("close", () => {
        this.socket = null;
        this.connecting = null;
        // A drop must not leave callers hanging until their own timeout.
        this.failAll(new Error("websocket closed"));
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private onMessage(ev: MessageEvent) {
    let text: string;
    const data = ev.data as unknown;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data as unknown as Uint8Array);
    } else text = String(data);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.warn("ws: unparseable frame", { sample: text.slice(0, 120) });
      return;
    }

    // A batch request comes back as one array frame; resolve it against the
    // id of its first entry, which is how send() registered it.
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const first = entries[0] as { id?: number } | undefined;
    if (typeof first?.id !== "number") return;
    const waiter = this.pending.get(first.id);
    if (!waiter) return;
    this.pending.delete(first.id);
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  }

  private failAll(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a single request or a batch; resolves with the raw parsed response. */
  async send(payload: unknown): Promise<unknown> {
    const ws = await this.connect();
    const entries = Array.isArray(payload) ? payload : [payload];
    const key = (entries[0] as { id: number }).id;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`rpc timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Nothing to do.
    }
    this.socket = null;
    this.failAll(new Error("transport closed"));
  }
}

export function isWsUrl(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

/**
 * The https:// twin of a wss:// URL.
 *
 * Providers commonly serve JSON-RPC over both schemes on the same host. HTTP
 * suits a serverless runtime better — no connection to establish or keep — so
 * it is worth trying first, but only as an addition: if the host is
 * WebSocket-only the original URL is still there to fall back to.
 */
export function httpTwin(url: string): string | null {
  if (!isWsUrl(url)) return null;
  return url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}
