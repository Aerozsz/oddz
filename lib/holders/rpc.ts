import { log } from "@/lib/logger";

/**
 * Minimal JSON-RPC client.
 *
 * Hand-rolled rather than pulling in viem/ethers: the tracker needs five
 * methods and hex codec for two types, and adding a 2MB dependency tree to a
 * Next.js bundle for that is not a trade worth making.
 *
 * Handles the two things public RPC endpoints actually do to you: they rate
 * limit, and they cap eth_getLogs ranges without documenting the cap.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly method: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Thrown when the endpoint refused a log range as too wide. */
export class RangeTooWideError extends RpcError {}

interface RpcRequest {
  method: string;
  params: unknown[];
}

const RANGE_HINTS = [
  "more than",
  "range",
  "limit exceeded",
  "query returned more than",
  "block range",
  "too many results",
  "response size exceeded",
  "log response size",
];

function isRangeComplaint(message: string): boolean {
  const m = message.toLowerCase();
  return RANGE_HINTS.some((h) => m.includes(h));
}

export class RpcClient {
  private urlIndex = 0;
  private nextId = 1;

  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 15_000,
  ) {}

  get configured(): boolean {
    return this.urls.length > 0;
  }

  get endpoint(): string | null {
    return this.urls[this.urlIndex] ?? null;
  }

  /**
   * One call. Rotates to the next endpoint on transport failure, so a dead
   * public RPC degrades to the next one instead of failing the whole refresh.
   */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const results = await this.batch<T>([{ method, params }]);
    const r = results[0];
    if (r instanceof Error) throw r;
    return r;
  }

  /**
   * Batched call. Returns one entry per request, in order; a per-request error
   * is returned in place rather than thrown, because a single reverting
   * balanceOf must not discard the other 99 results in the batch.
   */
  async batch<T>(requests: RpcRequest[]): Promise<(T | Error)[]> {
    if (requests.length === 0) return [];
    if (!this.configured) {
      const err = new RpcError("no RPC endpoint configured", null, requests[0].method);
      return requests.map(() => err);
    }

    const payload = requests.map((r) => ({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: r.method,
      params: r.params,
    }));

    let lastErr: Error = new RpcError("no attempt made", null, requests[0].method);

    // One pass over every endpoint before giving up.
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[this.urlIndex];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new RpcError(
            `rpc ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
            res.status,
            requests[0].method,
          );
        }
        const json = (await res.json()) as unknown;
        // Some endpoints unwrap a single-element batch, some do not.
        const arr = Array.isArray(json) ? json : [json];
        const byId = new Map<number, { result?: unknown; error?: { code: number; message: string } }>();
        for (const entry of arr) {
          const e = entry as { id?: number; result?: unknown; error?: { code: number; message: string } };
          if (typeof e?.id === "number") byId.set(e.id, e);
        }
        return payload.map((p, i) => {
          const entry = byId.get(p.id) ?? (arr.length === payload.length ? (arr[i] as never) : undefined);
          if (!entry) return new RpcError("missing response for request", null, p.method);
          if (entry.error) {
            const msg = entry.error.message ?? "rpc error";
            const Ctor = isRangeComplaint(msg) ? RangeTooWideError : RpcError;
            return new Ctor(msg, entry.error.code ?? null, p.method);
          }
          return entry.result as T;
        });
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        log.warn("rpc endpoint failed", {
          url,
          method: requests[0].method,
          error: lastErr.message.slice(0, 200),
        });
        this.urlIndex = (this.urlIndex + 1) % this.urls.length;
      } finally {
        clearTimeout(timer);
      }
    }
    return requests.map(() => lastErr);
  }

  async blockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber");
    return Number(BigInt(hex));
  }

  async chainId(): Promise<number | null> {
    try {
      const hex = await this.call<string>("eth_chainId");
      return Number(BigInt(hex));
    } catch {
      return null;
    }
  }
}

/** Hex helpers. Kept here so nothing else has to know the encoding. */
export const hex = {
  block: (n: number): string => "0x" + n.toString(16),
  toBigInt: (h: string | undefined | null): bigint => {
    if (!h || h === "0x") return 0n;
    try {
      return BigInt(h);
    } catch {
      return 0n;
    }
  },
  toNumber: (h: string | undefined | null): number => Number(hex.toBigInt(h)),
};
