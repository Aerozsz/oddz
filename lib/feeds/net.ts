import { brand } from "../brand";
import { HttpError } from "../http";

/**
 * Fetch a text/XML body (RSS, Atom) with the same timeout + retry posture as
 * `fetchJson`, but without the JSON/zod step — news feeds are XML. Honors a
 * caller-supplied abort signal (the monitor's time budget) alongside a
 * per-request timeout.
 */
export async function fetchText(
  url: string,
  opts: { signal?: AbortSignal; headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {},
): Promise<string> {
  const { signal: external, headers, timeoutMs = 10_000, retries = 2 } = opts;
  const baseHeaders: Record<string, string> = {
    "user-agent": `${brand.userAgent} (+https://github.com/${brand.social.github})`,
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    ...headers,
  };

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    try {
      const res = await fetch(url, { headers: baseHeaders, signal });
      if (!res.ok) {
        const retriable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (retriable && attempt < retries) {
          await sleep(400 * 2 ** attempt + Math.random() * 400);
          attempt++;
          continue;
        }
        throw new HttpError(`fetch ${res.status} ${res.statusText}`, res.status, url);
      }
      return await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (external?.aborted) throw err; // budget spent — stop
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt + Math.random() * 400);
        attempt++;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
