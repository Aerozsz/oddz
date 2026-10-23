// The "Ask Claude" panel. Sends each message with a snapshot of the dashboard to /api/chat, streams the answer in,
// and keeps every chat in this browser. The stored history is exactly what the server returned (thinking blocks
// included) and is only ever appended to, never edited.
(function () {
'use strict';
const $ = id => document.getElementById(id);
const KEY = 'btc-run-chats-v1';
const LIMIT_BYTES = 3_500_000; // the request body cap on Vercel is 4.5 MB
const run = window.__btcRun;
if (!$('chatLog') || !run) return;

let store = load();
let busy = false, ctl = null;

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.chats) return s; } catch (e) {}
  return { current: null, chats: {} };
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); return true; }
  catch (e) {
    // Storage full: drop the oldest other chats until it fits.
    const ids = Object.keys(store.chats).filter(id => id !== store.current).sort((a, b) => store.chats[a].updated - store.chats[b].updated);
    while (ids.length) { delete store.chats[ids.shift()]; try { localStorage.setItem(KEY, JSON.stringify(store)); note('Browser storage was full, so the oldest chats were removed.'); renderPick(); return true; } catch (e2) {} }
    note('This chat is too big to keep in the browser. Start a new chat.');
    return false;
  }
}
const cur = () => store.chats[store.current] || null;
function newChat() {
  const id = 'c' + Date.now().toString(36);
  store.chats[id] = { title: '', created: Date.now(), updated: Date.now(), history: [] };
  store.current = id; persist(); renderPick(); render();
}

// ----- rendering -----
function inline(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const bold = m[0][0] === '*', el = document.createElement(bold ? 'strong' : 'code');
    el.textContent = bold ? m[0].slice(2, -2) : m[0].slice(1, -1); parent.appendChild(el); last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
function md(el, text) {
  el.textContent = '';
  let list = null, para = [];
  const flush = () => { if (para.length) { const p = document.createElement('p'); inline(p, para.join(' ')); el.appendChild(p); para = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const li = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { flush(); if (!list) { list = document.createElement('ul'); el.appendChild(list); } const i = document.createElement('li'); inline(i, li[2]); list.appendChild(i); continue; }
    list = null;
    if (!line) { flush(); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); const p = document.createElement('p'); const s = document.createElement('strong'); s.textContent = h[1]; p.appendChild(s); el.appendChild(p); continue; }
    para.push(line);
  }
  flush();
}
// What to show for a stored API message: the trader's own words, or Claude's text. Tool traffic stays hidden.
function shown(m) {
  if (!Array.isArray(m.content)) return typeof m.content === 'string' ? { role: m.role, text: m.content } : null;
  if (m.role === 'user') { const t = m.content.filter(b => b.type === 'text' && !b.text.startsWith('<dashboard_state>')); return t.length ? { role: 'user', text: t.map(b => b.text).join('\n') } : null; }
  const t = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return t.trim() ? { role: 'assistant', text: t } : null;
}
function bubble(role, text, meta) {
  const d = document.createElement('div'); d.className = 'cmsg ' + role;
  if (role === 'user') d.textContent = text; else md(d, text);
  if (meta) { const m = document.createElement('div'); m.className = 'cmeta'; m.textContent = meta; d.appendChild(m); }
  return d;
}
function render() {
  const log = $('chatLog'); log.textContent = '';
  const c = cur();
  const items = c ? c.history.map(shown).filter(Boolean) : [];
  // Consecutive assistant turns (text before and after a lookup) read as one answer.
  const merged = [];
  for (const it of items) { const last = merged[merged.length - 1]; if (last && last.role === 'assistant' && it.role === 'assistant') last.text += '\n\n' + it.text; else merged.push({ ...it }); }
  if (!merged.length) {
    const w = document.createElement('div'); w.className = 'cwelcome';
    const p = document.createElement('p');
    p.textContent = 'Claude sees what the dashboard shows when you press Send: the position, prices, instructions, the log, recent candles and the liquidation map. It can also pull the full map, liquidation fills, other candle intervals and news.';
    w.appendChild(p);
    const s = document.createElement('div'); s.className = 'cstarters';
    for (const q of ['What should I watch for next?', 'Where are the liquidation clusters toward my bust?', 'Read the last 30 minutes of the tape.', 'Any news moving BTC right now?']) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = q;
      b.addEventListener('click', () => { $('chatIn').value = q; ask(); }); s.appendChild(b);
    }
    w.appendChild(s); log.appendChild(w);
    if (c && c.lastNote) { const n = document.createElement('div'); n.className = 'cmsg sys'; n.textContent = c.lastNote; log.appendChild(n); }
    return;
  }
  for (const it of merged) log.appendChild(bubble(it.role, it.text));
  if (c.lastNote) { const n = document.createElement('div'); n.className = 'cmsg sys'; n.textContent = c.lastNote; log.appendChild(n); }
  log.scrollTop = log.scrollHeight;
}
function renderPick() {
  const sel = $('chatPick'); sel.textContent = '';
  const ids = Object.keys(store.chats).sort((a, b) => store.chats[b].updated - store.chats[a].updated);
  for (const id of ids) {
    const c = store.chats[id], o = document.createElement('option');
    o.value = id; o.textContent = (c.title || 'New chat') + ' · ' + new Date(c.updated).toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (id === store.current) o.selected = true; sel.appendChild(o);
  }
}
function note(text) { const n = $('chatNote'); n.textContent = text || ''; n.hidden = !text; }
function setBusy(on) { busy = on; $('chatSend').disabled = on; $('chatStop').hidden = !on; $('chatPick').disabled = on; $('chatNew').disabled = on; $('chatDel').disabled = on; }

// ----- asking -----
async function ask() {
  const text = $('chatIn').value.trim();
  if (!text || busy) return;
  if (!cur()) newChat();
  const c = cur(), id = store.current;
  const body = JSON.stringify({ history: c.history, text, state: run.snapshot() });
  if (body.length > LIMIT_BYTES) { note('This chat is too long to send. Start a new chat.'); return; }
  $('chatIn').value = ''; note(''); c.lastNote = null; setBusy(true);
  const log = $('chatLog');
  if (!c.history.length) log.textContent = '';
  log.appendChild(bubble('user', text));
  const out = document.createElement('div'); out.className = 'cmsg assistant';
  const wait = document.createElement('span'); wait.className = 'cwait'; wait.textContent = 'Thinking...'; out.appendChild(wait);
  log.appendChild(out); log.scrollTop = log.scrollHeight;

  ctl = new AbortController();
  let answer = '', add = null, problem = null, endNote = null;
  try {
    const res = await fetch('/api/chat', { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-dashboard-key': run.passcode() }, body });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json()).error || ''; } catch (e) {}
      if (res.status === 401) { run.askPasscode('The chat needs the dashboard passcode.'); problem = 'Enter the dashboard passcode in the Feeds panel, then send again.'; }
      else if (res.status === 503) problem = 'The chat is not set up: add ANTHROPIC_API_KEY in the Vercel project settings and redeploy.';
      else problem = msg || `The chat route answered ${res.status}.`;
    } else {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.t === 'text') { answer += ev.d; md(out, answer); log.scrollTop = log.scrollHeight; }
          else if (ev.t === 'status') { if (answer) answer += '\n\n'; const s = document.createElement('div'); s.className = 'cwait'; s.textContent = ev.text + '...'; if (!answer) out.textContent = ''; out.appendChild(s); }
          else if (ev.t === 'done') { add = ev.add; endNote = ev.note; }
          else if (ev.t === 'error') { add = ev.add; problem = ev.error; }
        }
      }
      if (!add && !problem) problem = 'The connection closed before Claude finished. Send again.';
    }
  } catch (e) {
    problem = e && e.name === 'AbortError' ? 'Stopped.' : 'Could not reach the chat route. Check the connection and send again.';
  }
  ctl = null; setBusy(false);
  const chat = store.chats[id];
  if (chat) {
    // Append only whole turns the server confirmed. If nothing came back, keep the trader's words visible as a note.
    if (Array.isArray(add) && add.length) { chat.history.push(...add); if (!chat.title) chat.title = text.replace(/\s+/g, ' ').slice(0, 60); }
    else if (!problem) problem = 'No answer came back.';
    chat.lastNote = problem || endNote || null;
    if (!add || !add.length) chat.lastNote = (problem || 'No answer.') + ` Your message was: "${text.slice(0, 200)}"`;
    chat.updated = Date.now(); persist();
  }
  renderPick(); render(); $('chatIn').focus();
}

$('chatForm').addEventListener('submit', e => { e.preventDefault(); ask(); });
$('chatIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
$('chatStop').addEventListener('click', () => { if (ctl) ctl.abort(); });
$('chatNew').addEventListener('click', () => { if (!busy) newChat(); });
$('chatPick').addEventListener('change', e => { if (busy) return; store.current = e.target.value; persist(); render(); });
let delArmed = null;
$('chatDel').addEventListener('click', () => {
  const btn = $('chatDel');
  if (busy || !cur()) return;
  if (!delArmed) { btn.textContent = 'Confirm delete'; btn.classList.add('armed'); delArmed = setTimeout(() => { delArmed = null; btn.textContent = 'Delete'; btn.classList.remove('armed'); }, 4000); return; }
  clearTimeout(delArmed); delArmed = null; btn.textContent = 'Delete'; btn.classList.remove('armed');
  delete store.chats[store.current];
  const ids = Object.keys(store.chats).sort((a, b) => store.chats[b].updated - store.chats[a].updated);
  store.current = ids[0] || null; if (!store.current) newChat(); else { persist(); renderPick(); render(); }
});

if (!cur()) { const ids = Object.keys(store.chats); store.current = ids.length ? ids.sort((a, b) => store.chats[b].updated - store.chats[a].updated)[0] : null; }
if (!cur()) newChat(); else { renderPick(); render(); }
})();
