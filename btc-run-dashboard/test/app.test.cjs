// End-to-end page test in jsdom with a fake Hyperliquid WebSocket and mocked fetch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function page({ directHistoryFails = false, cvStatus = 200, passcode = 'pw', seed = null, candles = [] } = {}) {
  let html = pub('index.html');
  html = html.replace(/<script src="https:\/\/unpkg[^"]+"><\/script>/, '');
  for (const f of ['config.js', 'engine.js', 'feeds.js', 'app.js']) html = html.replace(`<script src="/${f}"></script>`, () => `<script>${pub(f)}</script>`);
  html = html.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${pub('styles.css')}</style>`);

  const errors = [], sockets = [], fetches = [];
  const state = { heat: null, liqs: { events: [] }, candles };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://btc-run.example/', virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.localStorage.setItem('btc-run-passcode', passcode);
      if (seed) w.localStorage.setItem('btc-run-dashboard-v1', seed);
      class FakeWS {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
        send(s) { this.sent.push(JSON.parse(s)); }
        close() { this.readyState = 3; setTimeout(() => this.onclose && this.onclose(), 1); }
        push(channel, data) { this.onmessage && this.onmessage({ data: JSON.stringify({ channel, data }) }); }
      }
      w.WebSocket = FakeWS;
      const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });
      w.fetch = async (url, opts = {}) => {
        url = String(url); fetches.push({ url, opts });
        if (url.startsWith('https://api.hyperliquid.xyz/info')) {
          if (directHistoryFails) throw new TypeError('Failed to fetch');
          return resp(200, state.candles);
        }
        if (url === '/api/hl') return resp(opts.headers['x-dashboard-key'] === 'pw' ? 200 : 401, state.candles);
        if (url.startsWith('/api/cv?')) {
          if (cvStatus !== 200) return resp(cvStatus, { error: 'passcode required' });
          const q = new URLSearchParams(url.split('?')[1]);
          if (q.get('route') === 'heatmap') return state.heat ? resp(200, state.heat, { 'x-ratelimit-remaining': '19000', 'x-ratelimit-limit': '20000' }) : resp(502, { error: 'none' });
          if (q.get('route') === 'liquidations') return resp(200, state.liqs);
        }
        return resp(404, {});
      };
    },
  });
  return { dom, w: dom.window, $: id => dom.window.document.getElementById(id), errors, sockets, fetches, state };
}

const M = 60000;
function candlesAround(fromMs, toMs, base) {
  const out = [];
  for (let t = Math.floor(fromMs / M) * M; t <= toMs; t += M) {
    const o = base + Math.sin(t / M) * 20;
    out.push({ t, T: t + M - 1, s: 'BTC', i: '1m', o: String(o), h: String(o + 15), l: String(o - 15), c: String(o + 5), v: '10', n: 5 });
  }
  return out;
}
function heat(price, longClusters, shortClusters) {
  const buckets = [];
  const w = price * 0.00125;
  for (let i = -40; i < 40; i++) {
    const low = price + i * w, high = low + w;
    let longN = 0, shortN = 0;
    for (const c of longClusters) if (low >= c[0] - 1e-6 && high <= c[1] + 1e-6) longN = c[2] / Math.max(1, Math.round((c[1] - c[0]) / w));
    for (const c of shortClusters) if (low >= c[0] - 1e-6 && high <= c[1] + 1e-6) shortN = c[2] / Math.max(1, Math.round((c[1] - c[0]) / w));
    buckets.push({ low, high, longNotional: low < price ? longN : 0, shortNotional: low >= price ? shortN : 0 });
  }
  return { coin: 'BTC', currentPrice: price, buckets };
}
const set = (w, $, id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('input')); };

(async () => {
  // ---------- Run 1: the full session ----------
  const P = page();
  const { w, $, sockets, fetches, errors, state } = P;
  await sleep(50);
  assert.strictEqual($('callAction').textContent, 'OFF', 'boots with monitoring off');
  assert.strictEqual($('connText').textContent, 'Monitoring off');
  assert.strictEqual(sockets.length, 0, 'no socket while off');
  assert.strictEqual(fetches.length, 0, 'no calls while off');

  // Fill in and track a short, opened 30 minutes ago.
  const opened = Date.now() - 30 * M;
  const local = new Date(opened - new Date(opened).getTimezoneOffset() * M).toISOString().slice(0, 16);
  set(w, $, 'tSide', 'short'); set(w, $, 'tOpened', local); set(w, $, 'tEntry', '82709.5'); set(w, $, 'tBust', '83496.8');
  set(w, $, 'tNotional', '299900'); set(w, $, 'tMargin', '2999.44'); set(w, $, 'tFee', '124'); set(w, $, 'tGoal', '9000');
  set(w, $, 'tPressure', '83000'); set(w, $, 'tInvalid', '83350');
  await sleep(30);
  assert.strictEqual($('dTp').textContent, '$81,020.4', 'target from the testnet numbers');
  $('startBtn').click();
  await sleep(30);
  assert.strictEqual(w.__btcRun.sim.status, 'open');
  assert.strictEqual($('callAction').textContent, 'OFF', 'tracked but monitoring still off');
  assert.ok(/nothing is checking/.test($('callText').textContent));

  // Turn monitoring on: history loads from the open time, then the stream connects.
  state.candles = candlesAround(opened - 5 * M, Date.now(), 81900);
  state.heat = heat(81900, [[81900 * (1 - 0.0025), 81900 * (1 - 0.00125), 12e6], [81900 * (1 - 0.0075), 81900 * (1 - 0.00625), 21e6]], [[81900 * 1.0125, 81900 * 1.01375, 16e6]]);
  $('monBtn').click();
  await sleep(60);
  assert.strictEqual($('monBtn').getAttribute('aria-pressed'), 'true');
  const hist = fetches.find(f => f.url.startsWith('https://api.hyperliquid.xyz/info'));
  assert.ok(hist, 'history requested directly from Hyperliquid');
  const req = JSON.parse(hist.opts.body).req;
  assert.ok(req.startTime <= Math.floor(opened / M) * M, 'history covers the open time');
  assert.ok(Math.abs(req.startTime - (Date.now() - 180 * M)) < 2 * M, 'and at least the default 180 minutes');
  const logText = () => [...w.document.querySelectorAll('#log li .lx')].map(x => x.textContent).join('\n');
  assert.ok(/Checked \d+ candles from .* against the bust\. It didn't print/.test(logText()), 'gap checked against the bust');
  assert.strictEqual(sockets.length, 1);
  const ws = sockets[0];
  assert.strictEqual(ws.url, 'wss://api.hyperliquid.xyz/ws');
  const subs = ws.sent.filter(m => m.method === 'subscribe').map(m => m.subscription.type).sort();
  assert.deepStrictEqual(subs, ['activeAssetCtx', 'bbo', 'candle', 'trades']);

  // Book, mark and a candle arrive.
  ws.push('bbo', { coin: 'BTC', time: Date.now(), bbo: [{ px: '81849', sz: '1', n: 1 }, { px: '81850', sz: '2', n: 2 }] });
  ws.push('activeAssetCtx', { coin: 'BTC', ctx: { markPx: '81851', oraclePx: '81860' } });
  await sleep(700);
  assert.strictEqual($('price').textContent, '81,850.0', 'price is the ask for a short');
  assert.strictEqual($('connText').textContent, 'Hyperliquid live');
  assert.ok(/81,851.0 mark, 81,860.0 oracle/.test($('srcMark').textContent));
  assert.strictEqual($('callAction').textContent, 'NO ACTION');

  // Liquidation map from Coinversa (polled 200 ms after start).
  await sleep(300);
  assert.ok(/^\$\d+(\.\d)?M$/.test($('balTV').textContent), 'target-side total shown: ' + $('balTV').textContent);
  assert.ok($('balTS').textContent.includes('long liquidations, price to target'));
  assert.ok($('balBS').textContent.includes('short liquidations, price to bust'));
  const clusterText = $('clusters').textContent;
  assert.ok(/Nearest long cluster\$12M at/.test(clusterText.replace(/\s+/g, '')) || clusterText.includes('Nearest long cluster'), clusterText);
  assert.ok(/Coinversa, updated/.test($('mapAge').textContent));
  assert.ok(/19000 left on the key/.test($('srcBudget').textContent), $('srcBudget').textContent);

  // A $6M taker buy is toward bust for a short: get ready.
  ws.push('trades', [
    { coin: 'BTC', side: 'B', px: '81860', sz: '40', time: Date.now(), hash: '0xabc', tid: 1, users: ['0x1', '0x2'] },
    { coin: 'BTC', side: 'B', px: '81870', sz: '33.3', time: Date.now(), hash: '0xabc', tid: 2, users: ['0x1', '0x3'] },
    { coin: 'BTC', side: 'A', px: '81850', sz: '1', time: Date.now(), hash: '0xdef', tid: 3, users: ['0x4', '0x5'] },
  ]);
  await sleep(50);
  const acts = () => w.__btcRun.sim.actions.filter(a => !a.done);
  const print = acts().find(a => a.id === 'print-0xabc:B');
  assert.ok(print, 'print raised');
  assert.strictEqual(print.level, 'prepare');
  assert.ok(/\$6\.0M taker buy order hit Hyperliquid at \$81,870\.0 across 2 fills, pushing toward bust/.test(print.text), print.text);
  assert.strictEqual($('callAction').textContent, 'GET READY');
  print.done = true;

  // Price trades down into the near long cluster, then the next map shows it gone: heads-up.
  ws.push('bbo', { coin: 'BTC', time: Date.now(), bbo: [{ px: '81669', sz: '1', n: 1 }, { px: '81670', sz: '2', n: 2 }] });
  await sleep(20);
  state.heat = heat(81700, [[81900 * (1 - 0.0075), 81900 * (1 - 0.00625), 21e6]], [[81900 * 1.0125, 81900 * 1.01375, 16e6]]);
  w.__btcRun.feeds.pollNow('heat');
  await sleep(200);
  const used = acts().find(a => String(a.id).startsWith('used-long-'));
  assert.ok(used, 'used-up cluster reported: ' + JSON.stringify(acts().map(a => a.id)));
  assert.ok(/long liquidation cluster at .* is mostly gone/.test(used.text) && /forced selling toward your target/.test(used.text), used.text);
  assert.ok(/Since the previous map/.test($('balNote').textContent));

  // Ask through the target: act now, press Close.
  ws.push('bbo', { coin: 'BTC', time: Date.now(), bbo: [{ px: '81019', sz: '1', n: 1 }, { px: '81020', sz: '2', n: 2 }] });
  await sleep(50);
  assert.strictEqual(w.__btcRun.sim.status, 'won');
  assert.strictEqual($('callAction').textContent, 'ACT NOW');
  assert.ok(/Press Close on the BTC short now\. The ask on Hyperliquid, \$81,020\.0/.test($('callText').textContent));

  // Monitoring off closes the socket (no confirm needed once the run is over).
  $('monBtn').click();
  await sleep(20);
  assert.strictEqual($('monBtn').getAttribute('aria-pressed'), 'false');
  assert.strictEqual(ws.readyState, 3, 'socket closed');
  const nFetch = fetches.length;
  await sleep(1700);
  assert.strictEqual(fetches.length, nFetch, 'no polling while off');
  const saved = JSON.parse(w.localStorage.getItem('btc-run-dashboard-v1'));
  assert.strictEqual(saved.monitorOn, false);
  assert.deepStrictEqual(errors, [], 'no page errors');
  P.dom.window.close();
  console.log('app run 1 passed: off by default, gap replay, stream, map, prints, used-up cluster, target, off');

  // ---------- Run 2: direct history blocked, proxy used; Coinversa locked ----------
  const Q = page({ directHistoryFails: true, cvStatus: 401 });
  await sleep(30);
  Q.state.candles = candlesAround(Date.now() - 180 * M, Date.now(), 81800);
  Q.$('monBtn').click();
  await sleep(120);
  assert.ok(Q.fetches.some(f => f.url === '/api/hl'), 'fell back to /api/hl');
  assert.ok(/candles loaded from Hyperliquid via \/api\/hl/.test(Q.$('srcCandles').textContent), Q.$('srcCandles').textContent);
  await sleep(300);
  assert.strictEqual(Q.$('passRow').hidden, false, 'passcode prompt shown on 401');
  assert.ok(/Locked/.test(Q.$('srcFuel').textContent));
  assert.deepStrictEqual(Q.errors, []);
  Q.dom.window.close();

  // ---------- Run 3: monitoring remembered across reloads; turning off an open position needs a second click ----------
  const R = page();
  await sleep(30);
  R.state.candles = candlesAround(Date.now() - 60 * M, Date.now(), 81800);
  const open2 = Date.now() - 10 * M;
  const l2 = new Date(open2 - new Date(open2).getTimezoneOffset() * M).toISOString().slice(0, 16);
  for (const [id, v] of [['tOpened', l2], ['tEntry', '82709.5'], ['tBust', '83496.8'], ['tNotional', '299900'], ['tMargin', '2999.44'], ['tGoal', '9000']]) set(R.w, R.$, id, v);
  R.$('startBtn').click();
  R.$('monBtn').click();
  await sleep(80);
  R.$('monBtn').click();
  assert.ok(/Confirm/.test(R.$('monText').textContent), 'first click arms');
  assert.strictEqual(R.$('monBtn').getAttribute('aria-pressed'), 'true');
  await sleep(4100);
  assert.strictEqual(R.$('monBtn').getAttribute('aria-pressed'), 'true', 'unconfirmed click times out and stays on');
  const stored = R.w.localStorage.getItem('btc-run-dashboard-v1');
  R.dom.window.close();
  // Reload: monitoring comes back on by itself and checks the gap first.
  const T = page({ seed: stored, candles: candlesAround(Date.now() - 60 * M, Date.now(), 81800) });
  await sleep(150);
  assert.strictEqual(T.sockets.length, 1, 'stream reconnects on reload');
  assert.strictEqual(T.$('monBtn').getAttribute('aria-pressed'), 'true');
  const tLog = [...T.w.document.querySelectorAll('#log li .lx')].map(x => x.textContent).join('\n');
  assert.ok(/Monitoring resumed on page load/.test(tLog), tLog);
  assert.ok(/against the bust\. It didn't print/.test(tLog));
  T.$('monBtn').click(); T.$('monBtn').click();
  await sleep(20);
  assert.strictEqual(T.$('monBtn').getAttribute('aria-pressed'), 'false', 'second click turns it off');
  assert.ok(/nothing is checking the short/.test(T.$('callText').textContent));
  assert.deepStrictEqual(T.errors, []);
  T.dom.window.close();
  console.log('app run 2 and 3 passed: proxy fallback, passcode prompt, armed off switch, resume on reload');
})().catch(e => { console.error(e); process.exit(1); });
