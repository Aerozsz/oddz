import { FAPI_WS, SYMBOL } from "../config";

/**
 * The five streams one contract needs, as a function of the contract.
 *
 * Built per instance rather than once at module load, so several engines can
 * run against different symbols in the same process — which is what watching a
 * group of correlated names requires.
 */
export function streamsFor(symbol: string): string[] {
  const lower = symbol.toLowerCase();
  return [
    `${lower}@depth@100ms`,
    `${lower}@aggTrade`,
    `${lower}@forceOrder`,
    `${lower}@markPrice@1s`,
    `${lower}@kline_1m`,
  ];
}

export const STREAMS = streamsFor(SYMBOL);

/** Correlation id echoed back in Binance's acknowledgement. */
const SUBSCRIBE_ID = 1;

export interface StreamMessage {
  stream: string;
  data: Record<string, unknown>;
}

type Handlers = {
  onMessage: (msg: StreamMessage) => void;
  /** Any frame that is not a stream payload — subscription replies and errors. */
  onControlFrame?: (raw: string) => void;
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
  /** Frames received per stream *name*, so a silent one can be identified. */
  private seen = new Map<string, number>();
  /** Per-stream sockets opened to rescue names the combined socket never sent. */
  private fallbacks = new Map<string, WebSocket>();
  private rescueTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly streams: string[];

  constructor(
    private handlers: Handlers,
    symbol: string = SYMBOL,
  ) {
    this.streams = streamsFor(symbol);
  }

  /** The stream names this socket asked for. */
  subscribedTo(): string[] {
    return [...this.streams];
  }

  start() {
    this.stopped = false;
    this.connect();
    // Binance sends a ping every few minutes; browsers answer it invisibly.
    // Silence for a full minute on a symbol with a live book means the socket
    // is a zombie, so force it round.
    this.staleCheck = setInterval(() => {
      if (this.stopped || !this.lastMessageAt) return;
      // Only meaningful for a socket that is actually up. While one is
      // connecting or backing off, lastMessageAt is still old by definition, so
      // checking here would report a stall every 15s and overwrite the real
      // reason for the outage with a misleading one.
      const ws = this.ws;
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        this.handlers.onError("no data for 60s — cycling socket");
        // Do not wait on this one again; the close path takes over from here.
        this.lastMessageAt = 0;
        ws.close();
      }
    }, 15_000);

    /*
     * Rescue any stream the combined socket never delivered.
     *
     * The combined endpoint takes its stream list as a `streams=` query with
     * `/` between names. Against this account only the first name in that list
     * was ever honoured: 2,320 depth frames in 241 seconds and nothing at all
     * on aggTrade, markPrice or kline, with no error frame and no reply to an
     * explicit SUBSCRIBE. The URL is correct and round-trips through URL()
     * unchanged, so whatever truncates it is not in this process and cannot be
     * fixed from inside it.
     *
     * The single-stream endpoint has no list to truncate: the name is a path
     * segment, one socket per stream. That is worse in the way the combined
     * socket is better — two sockets can interleave, so a liquidation and the
     * depth it removed may be seen out of order — which is why this is a
     * fallback and not the default. It opens only for names that have proven
     * silent, so a working combined socket never grows a second connection, and
     * ordering is only given up where the alternative is no data at all.
     *
     * Sixty seconds because aggTrade on a liquid contract is hundreds a second
     * and markPrice is one a second: any subscribed stream with nothing after a
     * minute is not quiet, it is absent.
     */
    this.rescueTimer = setTimeout(() => this.rescueSilentStreams(), 60_000);
  }

  /** Frames received per stream name, for reporting which are silent. */
  framesByStream(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of this.streams) out[name] = this.seen.get(name) ?? 0;
    return out;
  }

  private rescueSilentStreams() {
    if (this.stopped) return;
    for (const name of this.streams) {
      if ((this.seen.get(name) ?? 0) > 0) continue;
      if (this.fallbacks.has(name)) continue;
      this.openFallback(name);
    }
  }

  private openFallback(name: string) {
    // FAPI_WS ends in /stream; the single-stream endpoint is /ws/<name>.
    const base = FAPI_WS.replace(/\/stream$/, "");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}/ws/${name}`);
    } catch (err) {
      this.handlers.onError(
        `fallback socket for ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.fallbacks.set(name, ws);
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      try {
        const data = JSON.parse(ev.data as string) as Record<string, unknown>;
        /*
         * The single-stream endpoint sends the payload bare, without the
         * {stream, data} envelope the combined one uses. Wrapped here so every
         * consumer downstream sees one shape and none of them has to know which
         * socket a frame came from.
         */
        this.seen.set(name, (this.seen.get(name) ?? 0) + 1);
        this.handlers.onMessage({ stream: name, data });
      } catch {
        /* as above: a malformed frame is not worth tearing anything down for */
      }
    };
    ws.onclose = () => {
      if (this.fallbacks.get(name) !== ws) return;
      this.fallbacks.delete(name);
      // Reopened on the same terms as the main socket: only while running, and
      // only for a stream that is still silent.
      if (!this.stopped) setTimeout(() => { if (!this.stopped) this.rescueSilentStreams(); }, 2_000);
    };
    ws.onerror = () => this.handlers.onError(`fallback socket error on ${name}`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleCheck) clearInterval(this.staleCheck);
    if (this.rescueTimer) clearTimeout(this.rescueTimer);
    this.rescueTimer = null;
    for (const ws of this.fallbacks.values()) ws.close();
    this.fallbacks.clear();
    this.timer = null;
    this.staleCheck = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${FAPI_WS}?streams=${this.streams.join("/")}`;
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
      /*
       * Subscribe explicitly as well as by URL, because the URL alone did not
       * work and gave no sign of it.
       *
       * The combined-stream endpoint takes the list as a query parameter with
       * `/` between names, and a URL built that way is exactly what this client
       * sent — verified offline, it round-trips through URL() unchanged. What
       * arrived was 2,320 depth frames in 241 seconds and nothing whatever on
       * aggTrade, markPrice or kline: the first name in the list honoured and
       * the remaining four dropped, with no error frame, which is what a query
       * truncated at its first `/` somewhere in transit looks like from here.
       *
       * A SUBSCRIBE frame carries the names in a JSON array, so no separator
       * has to survive anything. It is idempotent for a stream already
       * subscribed, so the URL is left in place rather than swapped out — if
       * the query does arrive intact this changes nothing, and if it does not
       * this is what makes the other four streams appear. Binance acknowledges
       * with `{"result":null,"id":...}`, which the control-frame capture keeps,
       * so the next snapshot says whether the request was received rather than
       * leaving it to be inferred from the counts.
       */
      try {
        ws.send(JSON.stringify({ method: "SUBSCRIBE", params: this.streams, id: SUBSCRIBE_ID }));
      } catch (err) {
        this.handlers.onError(
          `subscribe frame failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.handlers.onOpen();
    };

    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      try {
        const parsed = JSON.parse(ev.data as string) as StreamMessage;
        if (parsed && typeof parsed.stream === "string") {
          this.seen.set(parsed.stream, (this.seen.get(parsed.stream) ?? 0) + 1);
          this.handlers.onMessage(parsed);
          return;
        }
        /*
         * Everything that is not a stream payload, kept rather than dropped.
         *
         * Binance answers a bad or rejected subscription on this same socket
         * with a frame carrying no `stream` field — `{result, id}` on success,
         * an error object otherwise. This branch used to be the implicit `else`
         * of the line above and discarded them all without a trace, which meant
         * the one message that could explain a subscription problem was the one
         * message guaranteed to be thrown away.
         *
         * It mattered: four of five subscribed streams delivered nothing for
         * weeks — no aggTrade, no markPrice, no kline, only depth — and every
         * surface reported a healthy socket, because a healthy socket is
         * exactly what it was. Whatever Binance said about the other four went
         * into this branch and vanished.
         */
        this.handlers.onControlFrame?.(ev.data as string);
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
