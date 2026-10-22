// Hyperliquid candle history, used only when the browser can't call api.hyperliquid.xyz directly.
// POST /api/hl with {"type":"candleSnapshot","req":{"coin":"BTC","interval":"1m","startTime":ms,"endTime":ms}}
const { passcodeOk, send } = require('./_auth');

const INFO = 'https://api.hyperliquid.xyz/info';
const INTERVAL_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!passcodeOk(req)) return send(res, 401, { error: 'passcode required' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  const r = b && b.req;
  if (!b || b.type !== 'candleSnapshot' || !r) return send(res, 400, { error: 'only candleSnapshot is allowed' });
  const step = INTERVAL_MS[r.interval];
  const start = Number(r.startTime), end = Number(r.endTime);
  if (!/^[A-Za-z0-9:#]{1,20}$/.test(String(r.coin || ''))) return send(res, 400, { error: 'bad coin' });
  if (!step) return send(res, 400, { error: 'interval must be 1m, 5m, 15m or 1h' });
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return send(res, 400, { error: 'bad time range' });
  if ((end - start) / step > 5000) return send(res, 400, { error: 'at most 5,000 candles per request' });
  const body = JSON.stringify({ type: 'candleSnapshot', req: { coin: String(r.coin), interval: r.interval, startTime: Math.floor(start), endTime: Math.floor(end) } });
  try {
    const up = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
    const text = await up.text();
    return send(res, up.ok ? 200 : 502, up.ok ? text : { error: `Hyperliquid answered ${up.status}` });
  } catch (e) {
    return send(res, 502, { error: e.name === 'TimeoutError' ? 'Hyperliquid timed out' : 'Hyperliquid unreachable' });
  }
};
