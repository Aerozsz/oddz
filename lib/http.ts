import { z, type ZodType } from "zod";
import { brand } from "./brand";
import { log } from "./logger";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions<T> extends Omit<RequestInit, "body"> {
  body?: unknown;
  schema: ZodType<T>;
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  source?: string;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson<T>(url: string, opts: FetchJsonOptions<T>): Promise<T> {
  const {
    schema,
    retries = 3,
    baseDelayMs = 400,
    timeoutMs = 10_000,
    body,
    headers,
    source = "http",
    ...rest
  } = opts;

  const init: RequestInit = {
    ...rest,
    headers: {
      accept: "application/json",
      "user-agent": `${brand.userAgent} (+https://github.com/${brand.social.github})`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (RETRIABLE_STATUS.has(res.status) && attempt < retries) {
          await backoff(attempt, baseDelayMs, res.headers.get("retry-after"));
          attempt++;
          continue;
        }
        throw new HttpError(`${source} ${res.status} ${res.statusText}`, res.status, url, text);
      }
      const json = (await res.json()) as unknown;
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        log.error("response schema mismatch", {
          source,
          url,
          issues: parsed.error.issues.slice(0, 5),
        });
        throw new Error(`${source}: response did not match schema`);
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (attempt < retries) {
        log.warn("http retry", { source, url, attempt, error: String(err), abort: isAbort });
        await backoff(attempt, baseDelayMs, null);
        attempt++;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function backoff(attempt: number, baseMs: number, retryAfter: string | null) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      await sleep(seconds * 1000);
      return;
    }
  }
  const jitter = Math.random() * baseMs;
  await sleep(baseMs * 2 ** attempt + jitter);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const empty = z.object({});
