// Tests for the two Vercel functions with a mocked upstream fetch.
const assert = require('assert');

function mockRes() {
  return { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}
const json = r => JSON.parse(r.body);
let calls = [];
let next = null;
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  const n = typeof next === 'function' ? next(url, opts) : next;
  return {
    ok: n.status >= 200 && n.status < 300, status: n.status,
    headers: { get: k => (n.headers || {})[k.toLowerCase()] ?? null },
    text: async () => (typeof n.body === 'string' ? n.body : JSON.stringify(n.body)),
  };
};

(async () => {
  const cv = require('../api/cv.js');
  const hl = require('../api/hl.js');
  const run = async (h, req) => { const res = mockRes(); await h({ headers: {}, query: {}, ...req }, res); return res; };

  // Passcode
  process.env.DASHBOARD_KEY = 'secret-pass';
  delete process.env.COINVERSA_API_KEY;
  let r = await run(cv, { method: 'GET', query: { route: 'heatmap' } });
  assert.strictEqual(r.statusCode, 401);
  r = await run(cv, { method: 'GET', headers: { 'x-dashboard-key': 'wrong-passX' }, query: { route: 'heatmap' } });
  assert.strictEqual(r.statusCode, 401);
  // Key missing
  r = await run(cv, { method: 'GET', headers: { 'x-dashboard-key': 'secret-pass' }, query: { route: 'heatmap' } });
  assert.strictEqual(r.statusCode, 503);
  assert.match(json(r).error, /COINVERSA_API_KEY/);
  process.env.COINVERSA_API_KEY = 'cvsa_test';
  const H = { 'x-dashboard-key': 'secret-pass' };
  // Validation
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'nope' } });
  assert.strictEqual(r.statusCode, 400);
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'heatmap', range: '2.5' } });
  assert.strictEqual(r.statusCode, 400);
  assert.match(json(r).error, /whole number/);
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'liquidations', since: '5 minutes' } });
  assert.strictEqual(r.statusCode, 400);
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'heatmap', coin: 'BTC/../x' } });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(calls.length, 0, 'nothing reached upstream yet');
  r = await run(cv, { method: 'POST', headers: H, query: { route: 'heatmap' } });
  assert.strictEqual(r.statusCode, 405);

  // Success, key header, rate headers, cache
  next = { status: 200, body: { buckets: [{ low: 1, high: 2, longNotional: 3, shortNotional: 0 }] }, headers: { 'x-ratelimit-remaining': '19990', 'x-ratelimit-limit': '20000' } };
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'heatmap', coin: 'BTC', range: '5', buckets: '80' } });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(json(r).buckets.length, 1);
  assert.strictEqual(r.headers['x-ratelimit-remaining'], '19990');
  assert.strictEqual(r.headers['x-cache'], 'miss');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.coinversa.ai/api/public/v1/live/liquidation-heatmap/BTC?range=5&buckets=80');
  assert.strictEqual(calls[0].opts.headers['X-API-Key'], 'cvsa_test');
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'heatmap', coin: 'BTC', range: '5', buckets: '80' } });
  assert.strictEqual(r.headers['x-cache'], 'hit');
  assert.strictEqual(calls.length, 1, 'second call served from cache');

  // Liquidations URL
  next = { status: 200, body: { events: [] } };
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'liquidations', coin: 'BTC', since: '3m', limit: '200' } });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls[1].url, 'https://api.coinversa.ai/api/public/v1/live/risk/liquidations/recent?coin=BTC&since=3m&limit=200');

  // Upstream errors pass through with their detail
  next = { status: 429, body: { detail: 'Rate limit exceeded' } };
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'plan' } });
  assert.strictEqual(r.statusCode, 429);
  assert.strictEqual(json(r).error, 'Rate limit exceeded');
  next = () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
  r = await run(cv, { method: 'GET', headers: H, query: { route: 'liquidations', since: '1h' } });
  assert.strictEqual(r.statusCode, 502);
  assert.match(json(r).error, /timed out/);

  // Hyperliquid proxy
  r = await run(hl, { method: 'GET', headers: H });
  assert.strictEqual(r.statusCode, 405);
  r = await run(hl, { method: 'POST', headers: {}, body: {} });
  assert.strictEqual(r.statusCode, 401);
  r = await run(hl, { method: 'POST', headers: H, body: { type: 'clearinghouseState', user: '0x0' } });
  assert.strictEqual(r.statusCode, 400);
  const now = Date.now();
  r = await run(hl, { method: 'POST', headers: H, body: { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: now - 6000 * 60000, endTime: now } } });
  assert.strictEqual(r.statusCode, 400);
  assert.match(json(r).error, /5,000/);
  next = { status: 200, body: [{ t: now - 60000, o: '1', h: '2', l: '0.5', c: '1.5' }] };
  const before = calls.length;
  r = await run(hl, { method: 'POST', headers: H, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: now - 120 * 60000, endTime: now } }) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(json(r).length, 1);
  assert.strictEqual(calls[before].url, 'https://api.hyperliquid.xyz/info');
  assert.strictEqual(JSON.parse(calls[before].opts.body).type, 'candleSnapshot');

  // Open when no passcode is configured
  delete process.env.DASHBOARD_KEY;
  next = { status: 200, body: { tier: 'pro' } };
  r = await run(cv, { method: 'GET', query: { route: 'plan' } });
  assert.strictEqual(r.statusCode, 200);
  console.log('api tests passed');
})().catch(e => { console.error(e); process.exit(1); });
