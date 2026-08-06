import { FAPI_WS, SYMBOL } from "../config";

const lower = SYMBOL.toLowerCase();

export const STREAMS = [
  `${lower}@depth@100ms`,
  `${lower}@aggTrade`,
  `${lower}@forceOrder`,
  `${lower}@markPrice@1s`,
  `${lower}@kline_1m`,
] as const;

export interface StreamMessage {
  stream: string;
  data: Record<string, unknown>;
}

type Handlers = {
  onMessage: (msg: StreamMessage) => void;
  onOpen: () => void;
  onClose: (reason: string) => void;
  onError: (err: string) => void;
};

/**
 * One combined socket carrying every stream this tool needs. Combined rather
 * than one socket per stream so that depth diffs, prints and liquidations
 * arrive in a single ordered sequence — a liquidation and the depth it removed
 * cannot be observed out of order.
 *
 * Reconnects with exponential backoff plus jitter. Binance drops connections
 * after 24h by design, and closes any socket that fails to answer a ping, so
 * the reconnect path is a normal occurrence rather than an error case.
 */
export class StreamClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private staleCheck: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  constructor(private handlers: Handlers) {}

  start() {
    this.stopped = false;
    this.connect();
    // Binance sends a ping every few minutes; browsers answer it invisibly.
    // Silence for a full minute on a symbol with a live book means the socket
    // is a zombie, so force it round.
    this.staleCheck = setInterval(() => {
      if (this.stopped || !this.lastMessageAt) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        this.handlers.onError("no data for 60s — cycling socket");
        this.ws?.close();
      }
    }, 15_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleCheck) clearInterval(this.staleCheck);
    this.timer = null;
    this.staleCheck = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${FAPI_WS}?streams=${STREAMS.join("/")}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.handlers.onOpen();
    };

    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      try {
        const parsed = JSON.parse(ev.data as string) as StreamMessage;
        if (parsed && typeof parsed.stream === "string") this.handlers.onMessage(parsed);
      } catch {
        /* a malformed frame is not worth tearing the socket down for */
      }
    };

    ws.onerror = () => {
      this.handlers.onError("websocket error");
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onClose(ev.reason || `closed (${ev.code})`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const backoff = Math.min(15_000, 500 * 2 ** this.attempt);
    const jitter = Math.random() * 400;
    this.attempt++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), backoff + jitter);
  }
}
