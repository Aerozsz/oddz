'use strict';
const $ = (id) => document.getElementById(id);
let mode = 'url';

// ---- Mode toggle ----
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mode = b.dataset.mode;
  for (const btn of $('mode').children) btn.classList.toggle('on', btn === b);
  $('url-fields').style.display = mode === 'url' ? '' : 'none';
  $('demo-note').style.display = mode === 'demo' ? '' : 'none';
  updateEst();
});

function updateEst() {
  const video = $('video').checked;
  const steps = parseInt($('max').value, 10) || 14;
  const secs = video ? Math.round(20 + steps * 5) : Math.round(12 + steps * 1.5);
  $('est').textContent = `~${secs < 60 ? secs + 's' : Math.ceil(secs / 60) + ' min'} · ${video ? 'player + MP4' : 'player only'}`;
}
$('video').addEventListener('change', updateEst);
$('max').addEventListener('input', updateEst);
updateEst();

// Reveal wallet options when the web3 toggle is on.
$('wallet').addEventListener('change', () => {
  $('wallet-adv').style.display = $('wallet').checked ? '' : 'none';
});

// ---- Run ----
$('run').addEventListener('click', run);
async function run() {
  const params = {
    mode,
    url: $('url').value.trim(),
    title: $('title').value.trim(),
    maxSteps: parseInt($('max').value, 10) || 14,
    video: $('video').checked,
    fps: 25,
    pace: parseFloat($('pace').value) || 1.35,
    wallet: $('wallet').checked,
    chain: $('chain').value,
    balanceEth: $('balanceEth').value.trim(),
    address: $('address').value.trim(),
  };
  $('run').disabled = true;
  $('result').classList.remove('show');
  $('progress').classList.add('show');
  $('log').innerHTML = '';
  $('phase').textContent = 'Starting…';
  setBar(-1);
  $('progress').scrollIntoView({ behavior: 'smooth' });

  let resp;
  try {
    resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    }).then((r) => r.json());
  } catch (e) {
    fail('Could not reach the Guideo server.');
    return;
  }
  if (resp.error) { fail(resp.error); return; }

  const es = new EventSource('/api/events/' + resp.jobId);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') addLog(ev.msg);
    else if (ev.type === 'phase') { $('phase').textContent = ev.msg; addLog(ev.msg, 'ok'); if (ev.phase === 'rendering') setBar(45); }
    else if (ev.type === 'progress') setBar(ev.progress);
    else if (ev.type === 'error') { es.close(); fail(ev.msg); }
    else if (ev.type === 'done') { es.close(); done(ev); }
  };
  es.onerror = () => { /* stream closed by server after terminal event */ };
}

function setBar(pct) {
  const pbar = $('pbar');
  if (pct < 0) { pbar.classList.add('indet'); $('pfill').style.width = '35%'; }
  else { pbar.classList.remove('indet'); $('pfill').style.width = pct + '%'; }
}
function addLog(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}
function fail(msg) {
  setBar(0);
  $('phase').textContent = 'Something went wrong';
  addLog('✗ ' + msg, 'err');
  $('run').disabled = false;
}

function done(ev) {
  setBar(100);
  $('phase').textContent = 'Done!';
  $('run').disabled = false;
  const base = '/guides/' + ev.guideId;
  $('result-body').innerHTML =
    `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(ev.title)}</div>` +
    `<div class="hint">${ev.steps} steps${ev.hasVideo ? ' · MP4 rendered' : ''}. Open the player and click <b>✦ Tweak</b> to edit anything.</div>`;
  const acts = $('result-actions');
  acts.innerHTML = '';
  acts.appendChild(linkBtn('▶ Open interactive player', base + '/player.html', true, true));
  if (ev.hasVideo) {
    acts.appendChild(linkBtn('⬇ Download MP4', base + '/guide.mp4?dl=1', false));
    acts.appendChild(linkBtn('⬇ player.html', base + '/player.html?dl=1', false));
  }
  acts.appendChild(linkBtn('⬇ guide.json', base + '/guide.json?dl=1', false));
  if (ev.capture) {
    acts.appendChild(linkBtn('⬇ wallet-calls.json', base + '/wallet-calls.json?dl=1', false));
    acts.appendChild(linkBtn('⬇ network.json', base + '/network.json?dl=1', false));
  }
  if (ev.capture) {
    $('result-body').innerHTML += '<div class="hint" style="margin-top:8px">Web3 capture saved. To fill in exact numbers, send the <b>wallet-calls.json</b> and <b>network.json</b> files above.</div>';
  }
  $('result-preview').innerHTML = ev.hasVideo
    ? `<video class="preview" src="${base}/guide.mp4" controls></video>`
    : '';
  $('result').classList.add('show');
  $('result').scrollIntoView({ behavior: 'smooth' });
  loadLib();
}

function linkBtn(label, href, primary, blank) {
  const a = document.createElement('a');
  a.className = 'btn small' + (primary ? ' primary' : '');
  a.textContent = label;
  a.href = href;
  if (blank) a.target = '_blank';
  return a;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

// ---- Library ----
$('refresh').addEventListener('click', loadLib);
async function loadLib() {
  let items = [];
  try { items = await fetch('/api/guides').then((r) => r.json()); } catch { return; }
  const lib = $('lib');
  if (!items.length) { lib.innerHTML = '<div class="empty">No guides yet — make one above.</div>'; return; }
  lib.innerHTML = '';
  for (const it of items) {
    const base = '/guides/' + it.id;
    const el = document.createElement('div');
    el.className = 'item';
    const when = new Date(it.createdAt).toLocaleString();
    el.innerHTML =
      `<div class="t">${escapeHtml(it.title)}</div>` +
      `<div class="m">${it.steps} steps${it.hasVideo ? '<span class="badge">MP4</span>' : ''}<br>${when}</div>` +
      `<div class="acts"></div>`;
    const acts = el.querySelector('.acts');
    if (it.hasPlayer) acts.appendChild(linkBtn('Open', base + '/player.html', true, true));
    if (it.hasVideo) acts.appendChild(linkBtn('MP4', base + '/guide.mp4?dl=1', false));
    lib.appendChild(el);
  }
}
loadLib();
