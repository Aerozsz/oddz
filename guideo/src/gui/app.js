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
    height: parseInt($('quality').value, 10) || 1440,
    pace: parseFloat($('pace').value) || 1.35,
    wallet: $('wallet').checked,
    assist: $('wallet').checked && $('assist').checked,
    fill: $('fill').checked,
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

// ---- Convert / export an edited player.html ----
$('htmlfile').addEventListener('change', () => {
  const f = $('htmlfile').files[0];
  $('html-est').textContent = f ? f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB' : '';
});
$('htmlformat').addEventListener('change', updateHtmlFormat);
function updateHtmlFormat() {
  const fmt = $('htmlformat').value;
  $('htmlfps-row').style.display = fmt === 'mp4' ? '' : 'none';
  $('run-html').textContent = fmt === 'mp4' ? '🎬 Render MP4 from this file'
    : fmt === 'gitbook' ? '📘 Export GitBook (.zip)'
    : fmt === 'social' ? '📣 Export social thread (.zip)'
    : fmt === 'vocs' ? '📗 Export Vocs project (.zip)'
    : fmt === 'deploy-static' ? '🚀 Deploy docs site to Vercel'
    : '🚀 Deploy Vocs site to Vercel';
}
updateHtmlFormat();
$('run-html').addEventListener('click', runHtml);
async function downloadZipFrom(endpoint, body, fallbackName) {
  $('run-html').disabled = true;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { const j = await resp.json().catch(() => ({})); alert('Export failed: ' + (j.error || resp.status)); return; }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const nm = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nm; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    alert('Could not reach the Guideo server.');
  } finally {
    $('run-html').disabled = false;
  }
}
function exportHtml(html, format) { return downloadZipFrom('/api/export-html', { html, format }, format + '.zip'); }
function exportHtmlVocs(html) { return downloadZipFrom('/api/vocs-html', { html }, 'vocs-project.zip'); }

async function deployHtml(html, engine, token) {
  const prod = confirm('Deploy to PRODUCTION?\n\nOK = production URL · Cancel = a shareable preview URL');
  $('result').classList.remove('show');
  $('progress').classList.add('show');
  $('log').innerHTML = '';
  $('phase').textContent = engine === 'vocs' ? 'Building & deploying your Vocs site…' : 'Deploying your docs site…';
  setBar(-1);
  $('progress').scrollIntoView({ behavior: 'smooth' });
  let resp;
  try {
    resp = await fetch('/api/deploy-html', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, engine, prod, token: token || '' }),
    }).then((r) => r.json());
  } catch (e) { fail('Could not reach the Guideo server.'); return; }
  if (resp.error) { fail(resp.error); return; }
  const es = new EventSource('/api/events/' + resp.jobId);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') addLog(ev.msg);
    else if (ev.type === 'phase') { $('phase').textContent = ev.msg; addLog(ev.msg, 'ok'); }
    else if (ev.type === 'error') {
      es.close();
      if (/authentication|token|log ?in/i.test(ev.msg) && !token) {
        const t = prompt('Vercel needs a token to deploy from here.\n\nPaste a Vercel token (vercel.com → Account Settings → Tokens):');
        if (t) { deployHtml(html, engine, t.trim()); return; }
      }
      fail(ev.msg);
    } else if (ev.type === 'done') { es.close(); done(ev); }
  };
  es.onerror = () => {};
}
async function runHtml() {
  const f = $('htmlfile').files[0];
  if (!f) { alert('Choose a player.html file first.'); return; }
  let html;
  try { html = await f.text(); } catch (e) { alert('Could not read that file.'); return; }
  if (!/id=["']?guide-data/i.test(html)) {
    alert("That doesn't look like a Guideo player.html — it has no embedded guide. Use the ⬇ player.html button in the player's Tweak studio.");
    return;
  }
  const fmt = $('htmlformat').value;
  if (fmt === 'gitbook' || fmt === 'social') { await exportHtml(html, fmt); return; }
  if (fmt === 'vocs') { await exportHtmlVocs(html); return; }
  if (fmt === 'deploy-static') { await deployHtml(html, 'static'); return; }
  if (fmt === 'deploy-vocs') { await deployHtml(html, 'vocs'); return; }
  $('run-html').disabled = true;
  $('result').classList.remove('show');
  $('progress').classList.add('show');
  $('log').innerHTML = '';
  $('phase').textContent = 'Uploading your guide…';
  setBar(-1);
  $('progress').scrollIntoView({ behavior: 'smooth' });

  let resp;
  try {
    resp = await fetch('/api/render-html', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, fps: parseInt($('htmlfps').value, 10) || 25, height: parseInt($('htmlquality').value, 10) || 1440, name: f.name }),
    }).then((r) => r.json());
  } catch (e) {
    fail('Could not reach the Guideo server.');
    $('run-html').disabled = false;
    return;
  }
  if (resp.error) { fail(resp.error); $('run-html').disabled = false; return; }

  const es = new EventSource('/api/events/' + resp.jobId);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') addLog(ev.msg);
    else if (ev.type === 'phase') { $('phase').textContent = ev.msg; addLog(ev.msg, 'ok'); }
    else if (ev.type === 'progress') setBar(ev.progress);
    else if (ev.type === 'error') { es.close(); fail(ev.msg); $('run-html').disabled = false; }
    else if (ev.type === 'done') { es.close(); $('run-html').disabled = false; done(ev); }
  };
  es.onerror = () => {};
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
  if (ev.deploy && ev.deployUrl) {
    $('result-body').innerHTML =
      `<div style="font-weight:600;margin-bottom:6px">🚀 Your docs site is live</div>` +
      `<div class="hint" style="margin-bottom:8px">Hosted on Vercel.</div>` +
      `<div><a class="btn small primary" href="${ev.deployUrl}" target="_blank">Open ${escapeHtml(ev.deployUrl)}</a></div>`;
    $('result-actions').innerHTML = '';
    $('result-preview').innerHTML = '';
    $('result').classList.add('show');
    $('result').scrollIntoView({ behavior: 'smooth' });
    loadLib();
    return;
  }
  const base = '/guides/' + ev.guideId;
  if (ev.fromHtml) {
    $('result-body').innerHTML =
      `<div style="font-weight:600;margin-bottom:4px">MP4 rendered from your edited guide</div>` +
      `<div class="hint">Every tweak you saved is baked into the video below.</div>`;
  } else {
    $('result-body').innerHTML =
      `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(ev.title)}</div>` +
      `<div class="hint">${ev.steps} steps${ev.hasVideo ? ' · MP4 rendered' : ''}. Open the player and click <b>✦ Tweak</b> to edit anything.</div>`;
  }
  const acts = $('result-actions');
  acts.innerHTML = '';
  acts.appendChild(linkBtn('▶ Open interactive player', base + '/player.html', true, true));
  if (ev.hasVideo) {
    acts.appendChild(linkBtn('⬇ Download MP4', base + '/guide.mp4?dl=1', false));
    acts.appendChild(linkBtn('⬇ player.html', base + '/player.html?dl=1', false));
  }
  if (!ev.fromHtml) acts.appendChild(linkBtn('⬇ guide.json', base + '/guide.json?dl=1', false));
  acts.appendChild(linkBtn('📘 GitBook (.zip)', '/api/export/' + ev.guideId + '?format=gitbook', false));
  acts.appendChild(linkBtn('📣 Social (.zip)', '/api/export/' + ev.guideId + '?format=social', false));
  acts.appendChild(actionBtn('📖 Preview docs site', (b) => previewSite(ev.guideId, b)));
  acts.appendChild(actionBtn('🚀 Deploy to Vercel', () => deploySite(ev.guideId)));
  acts.appendChild(linkBtn('⬇ Deployable site (.zip)', '/api/docsite/' + ev.guideId + '?zip=1', false));
  acts.appendChild(linkBtn('⬇ Vocs project (.zip)', '/api/vocs/' + ev.guideId, false));
  if (ev.capture) {
    acts.appendChild(linkBtn('⬇ wallet-calls.json', base + '/wallet-calls.json?dl=1', false));
    acts.appendChild(linkBtn('⬇ network.json', base + '/network.json?dl=1', false));
    acts.appendChild(linkBtn('⬇ connected DOM', base + '/dom/connected.html?dl=1', false));
    $('result-body').innerHTML += '<div class="hint" style="margin-top:8px">Web3 capture saved. To perfect the on-screen numbers, send the <b>connected DOM</b>, <b>wallet-calls.json</b> and <b>network.json</b> files above.</div>';
  }
  $('result-preview').innerHTML = ev.hasVideo
    ? `<video class="preview" src="${base}/guide.mp4" controls></video>`
    : '';
  $('result').classList.add('show');
  $('result').scrollIntoView({ behavior: 'smooth' });
  loadLib();
}

async function deploySite(id, token) {
  const prod = confirm('Deploy to PRODUCTION?\n\nOK = production URL · Cancel = a shareable preview URL');
  $('result').classList.remove('show');
  $('progress').classList.add('show');
  $('log').innerHTML = '';
  $('phase').textContent = 'Deploying to Vercel…';
  setBar(-1);
  $('progress').scrollIntoView({ behavior: 'smooth' });
  let resp;
  try {
    resp = await fetch('/api/deploy/' + id, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prod, token: token || '' }),
    }).then((r) => r.json());
  } catch (e) { fail('Could not reach the Guideo server.'); return; }
  if (resp.error) { fail(resp.error); return; }
  const es = new EventSource('/api/events/' + resp.jobId);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') addLog(ev.msg);
    else if (ev.type === 'phase') { $('phase').textContent = ev.msg; addLog(ev.msg, 'ok'); }
    else if (ev.type === 'error') {
      es.close();
      if (/authentication|token|log ?in/i.test(ev.msg) && !token) {
        const t = prompt('Vercel needs a token to deploy from here.\n\nPaste a Vercel token (vercel.com → Account Settings → Tokens):');
        if (t) { deploySite(id, t.trim()); return; }
      }
      fail(ev.msg);
    } else if (ev.type === 'done') { es.close(); done(ev); }
  };
  es.onerror = () => {};
}
async function previewSite(id, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Building…'; btn.style.pointerEvents = 'none'; }
  try {
    const r = await fetch('/api/docsite/' + id).then((x) => x.json());
    if (r.url) window.open(r.url, '_blank');
    else alert('Could not build the site: ' + (r.error || 'unknown error'));
  } catch (e) {
    alert('Could not reach the Guideo server.');
  } finally {
    if (btn) { btn.textContent = label; btn.style.pointerEvents = ''; }
  }
}
function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn small';
  b.textContent = label;
  b.onclick = () => onClick(b);
  return b;
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
    acts.appendChild(linkBtn('📘 GitBook', '/api/export/' + it.id + '?format=gitbook', false));
    acts.appendChild(linkBtn('📣 Social', '/api/export/' + it.id + '?format=social', false));
    acts.appendChild(actionBtn('📖 Docs site', (b) => previewSite(it.id, b)));
    acts.appendChild(linkBtn('📗 Vocs .zip', '/api/vocs/' + it.id, false));
    acts.appendChild(actionBtn('🚀 Deploy', () => deploySite(it.id)));
    lib.appendChild(el);
  }
}
loadLib();

// Show the running version so it's obvious when the UI is up to date.
fetch('/api/version').then((r) => r.json()).then((v) => {
  const el = $('ver');
  if (el) el.textContent = 'Guideo ' + v.version;
}).catch(() => {});
