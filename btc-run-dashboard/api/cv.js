// Coinversa proxy. Holds COINVERSA_API_KEY so it never reaches the browser, allows only the routes the page
// uses, validates their parameters, and caches each answer briefly so several open tabs share one upstream call.
// GET /api/cv?route=heatmap&coin=BTC&range=5&buckets=80
// GET /api/cv?route=liquidations&coin=BTC&since=3m&limit=200
// GET /api/cv?route=plan
const { passcodeOk, send } = require('./_auth');

const BASE = process.env.COINVERSA_API_URL || 'https://api.coinversa.ai/api/public/v1';
const COIN_RE = /^[A-Za-z0-9:#]{1,20}$/;
const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

const ROUTES = {
  heatmap: {
    ttl: 20000,
    build(q) {
      const coin = q.coin || 'BTC', range = int(q.range ?? 5, 1, 50), buckets = int(q.buckets ?? 80, 10, 100);
      if (!COIN_RE.test(coin)) return { error: 'bad coin' };
      if (range == null) return { error: 'range must be a whole number from 1 to 50' };
      if (buckets == null) return { error: 'buckets must be a whole number from 10 to 100' };
      return { path: `/live/liquidation-heatmap/${encodeURIComponent(coin)}`, params: { range, buckets } };
    },
  },
  liquidations: {
    ttl: 5000,
    build(q) {
      const coin = q.coin || 'BTC', since = q.since || '3m', limit = int(q.limit ?? 200, 1, 200);
      if (!COIN_RE.test(coin)) return { error: 'bad coin' };
      if (!/^\d{1,3}[mhd]$/.test(since)) return { error: 'since must look like 3m, 1h or 1d' };
      if (limit == null) return { error: 'limit must be a whole number from 1 to 200' };
      return { path: '/live/risk/liquidations/recent', params: { coin, since, limit } };
    },
  },
  plan: { ttl: 60000, build: () => ({ path: '/plan', params: {} }) },
};

const cache = new Map();
const RATE_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!passcodeOk(req)) return send(res, 401, { error: 'passcode required' });
  const apiKey = process.env.COINVERSA_API_KEY;
  if (!apiKey) return send(res, 503, { error: 'COINVERSA_API_KEY is not set on the server' });

  const q = req.query || {};
  const route = ROUTES[q.route];
  if (!route) return send(res, 400, { error: 'unknown route; use heatmap, liquidations or plan' });
  const built = route.build(q);
  if (built.error) return send(res, 400, { error: built.error });

  const url = new URL(BASE + built.path);
  for (const [k, v] of Object.entries(built.params)) url.searchParams.set(k, String(v));
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < route.ttl) return send(res, hit.status, hit.body, { ...hit.headers, 'x-cache': 'hit' });

  let upstream;
  try {
    upstream = await fetch(key, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return send(res, 502, { error: e.name === 'TimeoutError' ? 'Coinversa timed out' : 'Coinversa unreachable' });
  }
  const body = await upstream.text();
  const headers = {};
  for (const h of RATE_HEADERS) { const v = upstream.headers.get(h); if (v != null) headers[h] = v; }
  if (upstream.ok) {
    cache.set(key, { at: Date.now(), status: upstream.status, body, headers });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return send(res, 200, body, { ...headers, 'x-cache': 'miss' });
  }
  // Pass Coinversa's own error through so the page can show it (rate limits, plan limits, bad key).
  let detail = null;
  try { const j = JSON.parse(body); detail = j.detail || j.error || j.message || null; } catch (e) { detail = body.slice(0, 300) || null; }
  return send(res, upstream.status, { error: detail || `Coinversa answered ${upstream.status}` }, headers);
};
