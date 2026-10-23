// Tests for /api/chat with a fake Anthropic client and mocked upstream fetch, and for the chat panel in jsdom.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

function mockRes() {
  return { statusCode: 0, headers: {}, body: '', writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(s) { this.body += s; }, end(s) { if (s) this.body += s; this.writableEnded = true; } };
}
const lines = r => r.body.trim().split('\n').map(l => JSON.parse(l));

// A fake client.beta.messages.stream: each call takes the next scripted reply.
function fakeClient(replies, seen) {
  return { beta: { messages: { stream(params) {
    seen.push(JSON.parse(JSON.stringify(params)));
    const msg = replies.shift();
    const handlers = [];
    return {
      on(ev, fn) { if (ev === 'text') handlers.push(fn); return this; },
      async finalMessage() {
        for (const b of msg.content) if (b.type === 'text') handlers.forEach(h => h(b.text));
        return msg;
      },
    };
  } } } };
}

let fetches = [];
global.fetch = async (url, opts) => {
  fetches.push(String(url));
  if (String(url).includes('/live/liquidation-heatmap/BTC')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ currentPrice: 81366, asOf: '2026-10-22T23:53:23Z', totals: { longAtRisk: 1, shortAtRisk: 2 },
      buckets: [{ low: 81366, high: 82179.66, longNotional: 0, shortNotional: 16765840.25 }] }) };
  }
  return { ok: false, status: 404, text: async () => 'nope' };
};

(async () => {
  const chat = require('../api/chat.js');
  const run = async req => { const res = mockRes(); await chat({ headers: {}, method: 'POST', on() {}, ...req }, res); return res; };
  process.env.DASHBOARD_KEY = 'pw';
  delete process.env.ANTHROPIC_API_KEY;
  const H = { 'x-dashboard-key': 'pw' };

  let r = await run({ body: { text: 'hi', history: [] } });
  assert.strictEqual(r.statusCode, 401);
  r = await run({ headers: H, body: { text: 'hi', history: [] } });
  assert.strictEqual(r.statusCode, 503);
  assert.match(JSON.parse(r.body).error, /ANTHROPIC_API_KEY/);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.COINVERSA_API_KEY = 'cvsa_test';
  r = await run({ headers: H, body: { text: '', history: [] } });
  assert.strictEqual(r.statusCode, 400);
  r = await run({ headers: H, body: { text: 'hi', history: [{ role: 'system', content: 'x' }] } });
  assert.strictEqual(r.statusCode, 400);

  // One tool round, then an answer.
  const seen = [];
  const thinking = { type: 'thinking', thinking: '', signature: 'sig1' };
  chat.client = fakeClient([
    { stop_reason: 'tool_use', content: [thinking, { type: 'text', text: 'Checking the map. ' }, { type: 'tool_use', id: 'tu1', name: 'get_liquidation_map', input: { range: 3 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '$16.8M of shorts sit just above.' }] },
  ], seen);
  const history = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
  r = await run({ headers: H, body: { text: 'Where are the shorts?', history, state: { price: 81366 } } });
  assert.strictEqual(r.statusCode, 200);
  assert.match(r.headers['content-type'], /ndjson/);
  const ev = lines(r);
  assert.deepStrictEqual(ev.filter(e => e.t === 'text').map(e => e.d), ['Checking the map. ', '$16.8M of shorts sit just above.']);
  assert.ok(ev.some(e => e.t === 'status' && /liquidation map/.test(e.text)));
  const done = ev.find(e => e.t === 'done');
  assert.ok(done, 'done event');
  assert.deepStrictEqual(done.add.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(done.add[0].content[0].text, /<dashboard_state>[\s\S]*81366/);
  assert.strictEqual(done.add[0].content[1].text, 'Where are the shorts?');
  assert.deepStrictEqual(done.add[1].content[0], thinking, 'thinking block kept unchanged');
  assert.strictEqual(done.add[2].content[0].tool_use_id, 'tu1');
  assert.match(done.add[2].content[0].content, /16765840/);
  assert.ok(fetches.some(u => u.includes('range=3')), 'tool input used');
  // The request carried the earlier history unchanged, plus the new message, and the fallback settings.
  assert.deepStrictEqual(seen[0].messages.slice(0, 2), history);
  assert.strictEqual(seen[0].model, 'claude-opus-5-5');
  assert.strictEqual(seen[0].fallbacks, 'default');
  assert.deepStrictEqual(seen[0].betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(seen[1].messages.length, 5);

  // A refusal with no text adds only the user message and a note.
  chat.client = fakeClient([{ stop_reason: 'refusal', content: [] }], []);
  r = await run({ headers: H, body: { text: 'x', history: [] } });
  const d2 = lines(r).find(e => e.t === 'done');
  assert.strictEqual(d2.add.length, 1);
  assert.match(d2.note, /declined/);

  // A tool call cut off at max_tokens never runs and is not stored.
  chat.client = fakeClient([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Let me' }, { type: 'tool_use', id: 'tu2', name: 'get_candles', input: {} }] }], []);
  fetches = [];
  r = await run({ headers: H, body: { text: 'x', history: [] } });
  const d3 = lines(r).find(e => e.t === 'done');
  assert.deepStrictEqual(d3.add[1].content.map(b => b.type), ['text']);
  assert.strictEqual(fetches.length, 0);

  // Blocks the declined model wrote before a fallback are dropped; text survives.
  const fb = chat.afterFallback([
    { type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'partial' },
    { type: 'server_tool_use', id: 'st1', name: 'web_search' },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }, { type: 'thinking', thinking: '', signature: 't' }, { type: 'text', text: 'rest' },
  ]);
  assert.deepStrictEqual(fb.map(b => b.type), ['text', 'fallback', 'thinking', 'text']);
  console.log('chat api tests passed');

  // ----- the chat panel in the page -----
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  let html = pub('index.html').replace(/<script src="https:\/\/unpkg[^"]+"><\/script>/, '');
  for (const f of ['config.js', 'engine.js', 'feeds.js', 'app.js', 'chat.js']) html = html.replace(`<script src="/${f}"></script>`, () => `<script>${pub(f)}</script>`);
  const errors = [], posts = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://btc-run.example/', virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.TextEncoder = require('util').TextEncoder; w.TextDecoder = require('util').TextDecoder; // as in browsers
      w.localStorage.setItem('btc-run-passcode', 'pw');
      w.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
      w.fetch = async (url, opts = {}) => {
        if (url !== '/api/chat') return { ok: false, status: 404, json: async () => ({}) };
        const body = JSON.parse(opts.body); posts.push({ body, headers: opts.headers });
        const add = [{ role: 'user', content: [{ type: 'text', text: '<dashboard_state>{}</dashboard_state>' }, { type: 'text', text: body.text }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: '**Hold.** Bust is 0.9% away.' }] }];
        const chunks = [JSON.stringify({ t: 'status', text: 'Reading candles' }) + '\n', JSON.stringify({ t: 'text', d: '**Hold.** Bust' }) + '\n',
          JSON.stringify({ t: 'text', d: ' is 0.9% away.' }) + '\n' + JSON.stringify({ t: 'done', add, note: null }) + '\n'];
        const enc = new w.TextEncoder();
        return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (chunks.length ? { value: enc.encode(chunks.shift()), done: false } : { done: true }) }) } };
      };
    } });
  const w = dom.window, $ = id => w.document.getElementById(id);
  await new Promise(r2 => setTimeout(r2, 50));
  assert.ok($('chatLog').textContent.includes('Claude sees what the dashboard shows'));
  $('chatIn').value = 'What now?';
  $('chatForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await new Promise(r2 => setTimeout(r2, 100));
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].headers['x-dashboard-key'], 'pw');
  assert.strictEqual(posts[0].body.text, 'What now?');
  assert.deepStrictEqual(posts[0].body.history, []);
  assert.strictEqual(posts[0].body.state.status, 'idle', 'snapshot sent');
  assert.ok($('chatLog').querySelector('.cmsg.user').textContent === 'What now?');
  assert.strictEqual($('chatLog').querySelector('.cmsg.assistant strong').textContent, 'Hold.');
  const stored = JSON.parse(w.localStorage.getItem('btc-run-chats-v1'));
  const c = stored.chats[stored.current];
  assert.strictEqual(c.title, 'What now?');
  assert.strictEqual(c.history.length, 2);
  assert.strictEqual(c.history[1].content[0].signature, 'x', 'history stored exactly as returned');
  // The next message sends that history back unchanged.
  $('chatIn').value = 'And then?';
  $('chatForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await new Promise(r2 => setTimeout(r2, 100));
  assert.deepStrictEqual(posts[1].body.history, c.history);
  assert.deepStrictEqual(errors, []);
  console.log('chat panel tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
