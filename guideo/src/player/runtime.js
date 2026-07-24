/* Guideo player runtime — deterministic playback so the MP4 renderer can seek
   to any millisecond and screenshot an identical frame. No wall-clock reads
   inside render(); play() only advances a clock that feeds render().
   Also a lightweight on-canvas editor (move/resize caption + highlight boxes)
   with local autosave, so edits survive closing the window. */
(function () {
  'use strict';
  var FADE = 450; // crossfade duration between steps (ms)
  var FPS = 30;

  var original = JSON.parse(document.getElementById('guide-data').textContent);
  var app = document.getElementById('app');

  // ---- Build DOM ----
  app.innerHTML =
    '<div class="main">' +
      '<div class="topbar">' +
        '<span class="logo"><span class="dot"></span> Guideo</span>' +
        '<span class="title" id="g-title"></span>' +
        '<span class="spacer"></span>' +
        '<button class="tbtn" id="g-edit-toggle">✎ Edit layout</button>' +
        '<button class="tbtn" id="g-tweak-toggle">✦ Tweak</button>' +
      '</div>' +
      '<div class="stage-wrap"><div class="stage" id="stage">' +
        '<div class="layer" id="g-prev"></div>' +
        '<div class="layer" id="g-cur"></div>' +
        '<video class="layer media" id="g-video" muted playsinline preload="auto" style="display:none"></video>' +
        '<img class="layer media" id="g-gif" style="display:none" />' +
        '<svg class="dim" id="g-dim" viewBox="0 0 100 100" preserveAspectRatio="none" style="display:none">' +
          '<defs><mask id="g-dim-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
            '<rect x="0" y="0" width="100" height="100" fill="#fff"></rect>' +
          '</mask></defs>' +
          '<rect x="0" y="0" width="100" height="100" fill="#06070e" fill-opacity="0.6" mask="url(#g-dim-mask)"></rect>' +
        '</svg>' +
        '<div class="spots" id="g-spots"></div>' +
        '<div class="labels" id="g-labels"></div>' +
        '<div class="ripple" id="g-ripple" style="display:none"></div>' +
        '<div class="cursor" id="g-cursor" style="display:none">' +
          '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M5 3l14.5 6.6c.9.4.8 1.7-.1 2L13 13.4l-2.6 6.4c-.4.9-1.7.8-2-.1L5 3.9c-.2-.7.4-1.2 1-.9z" fill="#fff" stroke="#0b0c14" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
        '</div>' +
        '<div class="caption" id="g-caption"><span id="g-caption-text"></span><span class="cap-resize" id="g-cap-resize"></span></div>' +
        '<div class="edit-toolbar" id="g-edit-toolbar" style="display:none">' +
          '<button id="g-add-box">＋ Highlight box</button>' +
          '<button id="g-add-label">＋ Text label</button>' +
          '<button id="g-del-box">🗑 Delete selected</button>' +
          '<button id="g-del-step" class="danger">🗑 Delete step</button>' +
          '<span class="ehint">Drag to move · corner to resize · double-click a label to edit its text</span>' +
        '</div>' +
      '</div></div>' +
      '<div class="controls">' +
        '<div class="scrub">' +
          '<div class="track" id="g-track"><div class="fill" id="g-fill"></div><div class="ticks" id="g-ticks"></div></div>' +
          '<div class="time" id="g-time">0:00 / 0:00</div>' +
        '</div>' +
        '<div class="buttons">' +
          '<button class="cbtn" id="g-prev-btn" title="Previous step">⏮</button>' +
          '<button class="cbtn big" id="g-play" title="Play / pause">▶</button>' +
          '<button class="cbtn" id="g-next-btn" title="Next step">⏭</button>' +
          '<div class="steps-strip" id="g-strip"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tweak" id="g-tweak"></div>' +
    '<div class="toast" id="g-toast"></div>';

  var el = {
    title: document.getElementById('g-title'),
    prev: document.getElementById('g-prev'),
    cur: document.getElementById('g-cur'),
    video: document.getElementById('g-video'),
    gif: document.getElementById('g-gif'),
    spots: document.getElementById('g-spots'),
    ripple: document.getElementById('g-ripple'),
    cursor: document.getElementById('g-cursor'),
    caption: document.getElementById('g-caption'),
    captionText: document.getElementById('g-caption-text'),
    capResize: document.getElementById('g-cap-resize'),
    stage: document.getElementById('stage'),
    dim: document.getElementById('g-dim'),
    dimMask: document.getElementById('g-dim-mask'),
    labels: document.getElementById('g-labels'),
    fill: document.getElementById('g-fill'),
    ticks: document.getElementById('g-ticks'),
    time: document.getElementById('g-time'),
    track: document.getElementById('g-track'),
    strip: document.getElementById('g-strip'),
    play: document.getElementById('g-play'),
    toast: document.getElementById('g-toast'),
    editToggle: document.getElementById('g-edit-toggle'),
    editToolbar: document.getElementById('g-edit-toolbar'),
  };

  // ---- Normalisation + persistence ----
  function normalize(g) {
    for (var i = 0; i < g.steps.length; i++) {
      var s = g.steps[i];
      if (!s.highlights) s.highlights = s.highlight ? [s.highlight] : [];
      if (!s.labels) s.labels = [];
    }
    return g;
  }
  function saveKey() {
    var m = original.meta || {};
    return 'guideo:save:' + (m.title || '') + '|' + (m.createdAt || '');
  }
  function loadSaved() {
    if (window.__guideoNoRestore) return null;
    try { var s = localStorage.getItem(saveKey()); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function saveNow(silent) {
    try { localStorage.setItem(saveKey(), JSON.stringify(guide)); if (!silent) toast('Saved — your edits will be here next time'); }
    catch (e) { if (!silent) toast('Could not save (storage full?)'); }
  }
  var saveTimer = null;
  function markDirty() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveNow(true); }, 700);
  }
  function revert() {
    try { localStorage.removeItem(saveKey()); } catch (e) {}
    location.reload();
  }

  var savedGuide = loadSaved();
  var guide = normalize(savedGuide || JSON.parse(JSON.stringify(original)));
  var spotPool = [];
  var labelPool = [];
  var selected = -1;
  var selectedLabel = -1;
  var editMode = false;

  // ---- Timing state ----
  var starts = [];
  var total = 0;
  var timeMs = 0;
  var playing = false;
  var lastFrame = 0;

  function recompute() {
    starts = [];
    var t = 0;
    for (var i = 0; i < guide.steps.length; i++) {
      starts.push(t);
      t += Math.max(300, guide.steps[i].durationMs || 3500);
    }
    total = t;
  }
  function applyTheme() {
    var th = guide.theme || {};
    var r = document.documentElement.style;
    if (th.accent) r.setProperty('--g-accent', th.accent);
    document.body.style.fontFamily = th.font || '';
    el.caption.style.background = th.captionBg || '';
    el.caption.style.color = th.captionColor || '';
    el.cursor.querySelector('path').setAttribute('fill', th.cursorColor || '#fff');
  }
  function buildChips() {
    el.strip.innerHTML = '';
    el.ticks.innerHTML = '';
    for (var i = 0; i < guide.steps.length; i++) {
      (function (i) {
        var c = document.createElement('div');
        c.className = 'chip';
        c.textContent = (i + 1) + '. ' + (guide.steps[i].title || 'Step');
        c.onclick = function () { seekStep(i); };
        el.strip.appendChild(c);
        var tk = document.createElement('div');
        tk.className = 'tick';
        tk.style.left = (starts[i] / total * 100) + '%';
        el.ticks.appendChild(tk);
      })(i);
    }
    for (var j = 0; j < guide.steps.length; j++) { var im = new Image(); im.src = guide.steps[j].image; }
  }

  function stepAt(t) { var i = 0; for (var k = 0; k < starts.length; k++) if (starts[k] <= t) i = k; return i; }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function animTransform(kind, p) {
    var e = easeInOut(Math.max(0, Math.min(1, p)));
    switch (kind) {
      case 'kenburns-in': return 'scale(' + (1 + 0.08 * e) + ') translateY(' + (-1 * e) + '%)';
      case 'kenburns-out': return 'scale(' + (1.08 - 0.08 * e) + ')';
      case 'pan-left': return 'scale(1.06) translateX(' + (-3 * e) + '%)';
      case 'pan-right': return 'scale(1.06) translateX(' + (3 * e) + '%)';
      default: return 'scale(1.001)';
    }
  }

  function ensureSpots(n) {
    while (spotPool.length < n) {
      (function () {
        var d = document.createElement('div');
        d.className = 'spotlight';
        d.innerHTML = '<div class="sp-resize"></div>';
        var idx = spotPool.length;
        d.addEventListener('pointerdown', function (ev) {
          if (!editMode) return;
          ev.stopPropagation();
          selected = idx;
          var step = guide.steps[stepAt(timeMs)];
          var h = step.highlights[idx];
          if (!h) return;
          if (ev.target.classList.contains('sp-resize')) {
            beginDrag(ev, function (nx, ny) { h.w = clampMin(nx - h.x, 0.03); h.h = clampMin(ny - h.y, 0.03); render(timeMs); });
          } else {
            var r = stageRect(), ox = (ev.clientX - r.left) / r.width - h.x, oy = (ev.clientY - r.top) / r.height - h.y;
            beginDrag(ev, function (nx, ny) { h.x = clamp01(nx - ox); h.y = clamp01(ny - oy); render(timeMs); });
          }
          render(timeMs);
        });
        el.spots.appendChild(d);
        spotPool.push(d);
      })();
    }
  }

  function ensureLabels(n) {
    while (labelPool.length < n) {
      (function () {
        var d = document.createElement('div');
        d.className = 'glabel';
        d.innerHTML = '<span class="gl-text"></span><button class="gl-del" title="Delete">✕</button>';
        var idx = labelPool.length;
        var span = d.querySelector('.gl-text');
        d.querySelector('.gl-del').addEventListener('click', function (ev) {
          ev.stopPropagation();
          var step = guide.steps[stepAt(timeMs)];
          if (step.labels && step.labels[idx]) { step.labels.splice(idx, 1); selectedLabel = -1; render(timeMs); markDirty(); refreshTweak(); }
        });
        span.addEventListener('dblclick', function (ev) {
          if (!editMode) return;
          ev.stopPropagation();
          span.setAttribute('contenteditable', 'true');
          span.focus();
          document.execCommand && document.execCommand('selectAll', false, null);
        });
        span.addEventListener('blur', function () {
          span.removeAttribute('contenteditable');
          var step = guide.steps[stepAt(timeMs)];
          if (step.labels && step.labels[idx]) { step.labels[idx].text = span.textContent; markDirty(); refreshTweak(); }
        });
        span.addEventListener('keydown', function (ev) { if (ev.code === 'Enter') { ev.preventDefault(); span.blur(); } });
        d.addEventListener('pointerdown', function (ev) {
          if (!editMode || span.getAttribute('contenteditable') === 'true' || ev.target.classList.contains('gl-del')) return;
          ev.stopPropagation();
          selectedLabel = idx; selected = -1;
          var step = guide.steps[stepAt(timeMs)];
          var lb = step.labels[idx];
          if (!lb) return;
          var r = stageRect(), ox = (ev.clientX - r.left) / r.width - lb.x, oy = (ev.clientY - r.top) / r.height - lb.y;
          beginDrag(ev, function (nx, ny) { lb.x = clamp01(nx - ox); lb.y = clamp01(ny - oy); render(timeMs); });
          render(timeMs);
        });
        el.labels.appendChild(d);
        labelPool.push(d);
      })();
    }
  }

  function render(t) {
    t = Math.max(0, Math.min(total, t));
    var i = stepAt(t);
    var step = guide.steps[i];
    var local = t - starts[i];
    var dur = Math.max(300, step.durationMs || 3500);
    var p = local / dur;
    var fade = i === 0 ? 1 : Math.max(0, Math.min(1, local / FADE));
    var vis = editMode ? 1 : fade;

    var xform = editMode ? 'scale(1.001)' : animTransform(step.animation, p);
    var hasVideo = !!step.video, hasGif = !!step.gif;

    // Background image layer (only when there's no video/gif).
    el.cur.style.display = hasVideo || hasGif ? 'none' : '';
    if (!hasVideo && !hasGif) {
      el.cur.style.backgroundImage = 'url("' + step.image + '")';
      el.cur.style.opacity = vis;
      el.cur.style.transform = xform;
      el.cur.style.transformOrigin = 'center center';
    }

    // Video layer — currentTime driven from the step's local time (deterministic).
    if (hasVideo) {
      if (el.video.getAttribute('data-src') !== step.video) { el.video.src = step.video; el.video.setAttribute('data-src', step.video); el.video.muted = true; el.video.load(); }
      el.video.setAttribute('data-frac', dur > 0 ? (local / dur) : 0);
      el.video.style.display = ''; el.video.style.opacity = vis; el.video.style.transform = xform; el.video.style.transformOrigin = 'center center';
      var vd = el.video.duration;
      if (playing && isFinite(vd) && vd > 0) {
        var vt = Math.min(vd - 0.03, Math.max(0, (local / dur) * vd));
        try { if (Math.abs(el.video.currentTime - vt) > 0.06) el.video.currentTime = vt; } catch (e) {}
      }
    } else { el.video.style.display = 'none'; }

    // GIF layer — animates on its own (best-effort in the MP4).
    if (hasGif) {
      if (el.gif.getAttribute('data-src') !== step.gif) { el.gif.src = step.gif; el.gif.setAttribute('data-src', step.gif); }
      el.gif.style.display = ''; el.gif.style.opacity = vis; el.gif.style.transform = xform; el.gif.style.transformOrigin = 'center center';
    } else { el.gif.style.display = 'none'; }

    if (i > 0 && fade < 1 && !editMode) {
      var prev = guide.steps[i - 1];
      if (prev.video || prev.gif) { el.prev.style.display = 'none'; }
      else {
        el.prev.style.display = '';
        el.prev.style.backgroundImage = 'url("' + prev.image + '")';
        el.prev.style.transform = animTransform(prev.animation, 1);
      }
    } else { el.prev.style.display = 'none'; }

    // caption
    var lead = step.title ? '<span class="lead">' + escapeHtml(step.title) + '</span>' : '';
    el.captionText.innerHTML = lead + escapeHtml(step.caption || '');
    var capA = timeAlpha(step.captionT0, step.captionT1, p, editMode);
    el.caption.style.opacity = capA * vis;
    el.caption.style.display = (step.caption || step.title || editMode) ? '' : 'none';
    el.caption.classList.toggle('top', step.captionPos === 'top');
    el.caption.classList.toggle('editing', editMode);
    if (step.captionBox) {
      var cb = step.captionBox;
      el.caption.style.left = (cb.x * 100) + '%';
      el.caption.style.top = (cb.y * 100) + '%';
      el.caption.style.right = 'auto';
      el.caption.style.bottom = 'auto';
      el.caption.style.width = (cb.w * 100) + '%';
    } else {
      el.caption.style.left = ''; el.caption.style.right = ''; el.caption.style.width = '';
      el.caption.style.top = step.captionPos === 'top' ? '' : 'auto';
      el.caption.style.bottom = '';
    }

    // cursor + ripple
    if (step.cursor) {
      el.cursor.style.display = '';
      el.cursor.style.left = (step.cursor.x * 100) + '%';
      el.cursor.style.top = (step.cursor.y * 100) + '%';
      el.cursor.style.opacity = vis;
      if (step.cursor.click && !editMode) {
        var rp = (local % 1600) / 1600;
        el.ripple.style.display = '';
        el.ripple.style.left = (step.cursor.x * 100) + '%';
        el.ripple.style.top = (step.cursor.y * 100) + '%';
        el.ripple.style.transform = 'scale(' + (0.5 + rp * 0.85) + ')';
        el.ripple.style.opacity = (1 - rp) * 0.45 * fade;
      } else { el.ripple.style.display = 'none'; }
    } else { el.cursor.style.display = 'none'; el.ripple.style.display = 'none'; }

    // highlights — one dim layer with a hole cut out for each active box
    var hs = step.highlights || [];
    ensureSpots(hs.length);
    while (el.dimMask.childNodes.length > 1) el.dimMask.removeChild(el.dimMask.lastChild);
    var anyBox = false, maxA = 0;
    for (var s = 0; s < spotPool.length; s++) {
      var d = spotPool[s];
      if (s < hs.length) {
        var h = hs[s];
        var ha = timeAlpha(h.t0, h.t1, p, editMode);
        d.style.display = ha > 0 ? '' : 'none';
        d.style.left = (h.x * 100) + '%';
        d.style.top = (h.y * 100) + '%';
        d.style.width = (h.w * 100) + '%';
        d.style.height = (h.h * 100) + '%';
        d.style.opacity = ha * vis;
        d.classList.toggle('editing', editMode);
        d.classList.toggle('sel', editMode && s === selected);
        if (ha > 0.02) {
          anyBox = true; if (ha > maxA) maxA = ha;
          var rc = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rc.setAttribute('x', (h.x * 100).toFixed(2));
          rc.setAttribute('y', (h.y * 100).toFixed(2));
          rc.setAttribute('width', (h.w * 100).toFixed(2));
          rc.setAttribute('height', (h.h * 100).toFixed(2));
          rc.setAttribute('rx', '1.2');
          rc.setAttribute('fill', '#000');
          el.dimMask.appendChild(rc);
        }
      } else { d.style.display = 'none'; }
    }
    if (anyBox) { el.dim.style.display = ''; el.dim.style.opacity = (editMode ? 0.6 : 1) * vis * maxA; }
    else { el.dim.style.display = 'none'; }

    // text labels
    var lbs = step.labels || [];
    var stageH = el.stage.getBoundingClientRect().height || 800;
    ensureLabels(lbs.length);
    for (var L = 0; L < labelPool.length; L++) {
      var ld = labelPool[L];
      if (L < lbs.length) {
        var lb = lbs[L];
        var la = timeAlpha(lb.t0, lb.t1, p, editMode);
        ld.style.display = la > 0 ? '' : 'none';
        ld.style.left = (lb.x * 100) + '%';
        ld.style.top = (lb.y * 100) + '%';
        ld.style.fontSize = ((lb.size || 0.045) * stageH) + 'px';
        ld.style.color = lb.color || '#ffffff';
        ld.style.opacity = la * vis;
        ld.classList.toggle('bg', !!lb.bg);
        ld.classList.toggle('editing', editMode);
        ld.classList.toggle('sel', editMode && L === selectedLabel);
        var sp = ld.querySelector('.gl-text');
        if (sp.getAttribute('contenteditable') !== 'true' && sp.textContent !== (lb.text || '')) sp.textContent = lb.text || '';
      } else { ld.style.display = 'none'; }
    }

    // controls
    el.fill.style.width = (t / total * 100) + '%';
    el.time.textContent = fmt(t) + ' / ' + fmt(total);
    el.title.textContent = guide.meta ? guide.meta.title : '';
    var chips = el.strip.children;
    for (var c = 0; c < chips.length; c++) chips[c].className = 'chip' + (c === i ? ' active' : '');
  }

  function fmt(ms) { var s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  // Opacity for an element timed to appear only within [t0,t1] of the step.
  function timeAlpha(t0, t1, p, edit) {
    if (edit) return 1;
    var a = t0 == null ? 0 : t0, b = t1 == null ? 1 : t1;
    if (a <= 0 && b >= 1) return 1;
    if (p < a || p > b) return 0;
    var w = 0.06;
    return Math.max(0, Math.min(1, (p - a) / w, (b - p) / w));
  }
  function clampMin(n, m) { return Math.max(m, Math.min(1, n)); }
  function stageRect() { return el.stage.getBoundingClientRect(); }
  function beginDrag(ev, onMove) {
    ev.preventDefault();
    var r = stageRect();
    function mv(e) { onMove(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height), e); }
    function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); markDirty(); refreshTweak(); }
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  }

  // ---- Caption dragging ----
  el.caption.addEventListener('pointerdown', function (ev) {
    if (!editMode) return;
    var step = guide.steps[stepAt(timeMs)];
    if (!step.captionBox) {
      var cr = el.caption.getBoundingClientRect(), sr = stageRect();
      step.captionBox = { x: (cr.left - sr.left) / sr.width, y: (cr.top - sr.top) / sr.height, w: cr.width / sr.width };
    }
    var cb = step.captionBox;
    if (ev.target === el.capResize) {
      beginDrag(ev, function (nx) { cb.w = clampMin(nx - cb.x, 0.12); render(timeMs); });
    } else {
      var r = stageRect(), ox = (ev.clientX - r.left) / r.width - cb.x, oy = (ev.clientY - r.top) / r.height - cb.y;
      beginDrag(ev, function (nx, ny) { cb.x = clamp01(nx - ox); cb.y = clamp01(ny - oy); render(timeMs); });
    }
    render(timeMs);
  });

  // ---- Playback ----
  function loop(ts) {
    if (!playing) return;
    if (!lastFrame) lastFrame = ts;
    var dt = ts - lastFrame; lastFrame = ts; timeMs += dt;
    if (timeMs >= total) { timeMs = total; pause(); render(timeMs); el.play.textContent = '↻'; return; }
    render(timeMs); requestAnimationFrame(loop);
  }
  function play() { if (editMode) return; if (timeMs >= total) timeMs = 0; playing = true; lastFrame = 0; el.play.textContent = '❚❚'; requestAnimationFrame(loop); }
  function pause() { playing = false; el.play.textContent = '▶'; }
  function toggle() { playing ? pause() : play(); }
  function seek(ms) { pause(); timeMs = Math.max(0, Math.min(total, ms)); render(timeMs); el.play.textContent = timeMs >= total ? '↻' : '▶'; return mediaReady(); }
  // Resolve once the (visible) video has the requested frame decoded — used by
  // the MP4 renderer so each screenshot captures the correct video frame.
  function once(target, ev, ms) {
    return new Promise(function (res) { var d = function () { target.removeEventListener(ev, d); res(); }; target.addEventListener(ev, d); setTimeout(res, ms); });
  }
  async function mediaReady() {
    var v = el.video;
    if (v.style.display === 'none') return;
    if (v.readyState < 1) await once(v, 'loadedmetadata', 1500);
    if (isFinite(v.duration) && v.duration > 0) {
      var frac = parseFloat(v.getAttribute('data-frac') || '0');
      var vt = Math.min(v.duration - 0.03, Math.max(0, frac * v.duration));
      if (Math.abs(v.currentTime - vt) > 0.02) { v.currentTime = vt; await once(v, 'seeked', 900); }
      else if (v.readyState < 2) await once(v, 'loadeddata', 900);
    }
  }
  function seekStep(i) { selected = -1; selectedLabel = -1; seek(starts[Math.max(0, Math.min(starts.length - 1, i))] + FADE + 50); }

  el.play.onclick = toggle;
  document.getElementById('g-prev-btn').onclick = function () { seekStep(stepAt(timeMs) - 1); };
  document.getElementById('g-next-btn').onclick = function () { seekStep(stepAt(timeMs) + 1); };
  el.track.onclick = function (e) { var r = el.track.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * total); };
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (editMode && (e.code === 'Delete' || e.code === 'Backspace')) { e.preventDefault(); deleteSelected(); return; }
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowRight') seekStep(stepAt(timeMs) + 1);
    else if (e.code === 'ArrowLeft') seekStep(stepAt(timeMs) - 1);
  });

  // ---- Edit mode ----
  function setEdit(on) {
    editMode = on;
    pause();
    el.editToggle.classList.toggle('on', on);
    el.editToolbar.style.display = on ? '' : 'none';
    el.stage.classList.toggle('editmode', on);
    if (on) { seek(starts[stepAt(timeMs)] + FADE + 60); } else { selected = -1; render(timeMs); }
  }
  el.editToggle.onclick = function () { setEdit(!editMode); };
  document.getElementById('g-add-box').onclick = function () {
    var step = guide.steps[stepAt(timeMs)];
    if (!step.highlights) step.highlights = [];
    step.highlights.push({ x: 0.38, y: 0.4, w: 0.24, h: 0.16 });
    selected = step.highlights.length - 1;
    render(timeMs); markDirty(); refreshTweak();
    toast('Box added — drag it into place');
  };
  document.getElementById('g-del-box').onclick = deleteSelected;
  function deleteSelected() {
    var step = guide.steps[stepAt(timeMs)];
    if (selectedLabel >= 0 && step.labels && step.labels[selectedLabel]) {
      step.labels.splice(selectedLabel, 1); selectedLabel = -1; render(timeMs); markDirty(); refreshTweak(); return;
    }
    if (selected >= 0 && step.highlights && step.highlights[selected]) {
      step.highlights.splice(selected, 1); selected = -1; render(timeMs); markDirty(); refreshTweak();
    }
  }
  document.getElementById('g-add-label').onclick = function () {
    var step = guide.steps[stepAt(timeMs)];
    if (!step.labels) step.labels = [];
    step.labels.push({ x: 0.4, y: 0.4, text: 'New label', size: 0.05, color: '#ffffff', bg: true });
    selectedLabel = step.labels.length - 1; selected = -1;
    render(timeMs); markDirty(); refreshTweak();
    setTimeout(function () { var d = labelPool[selectedLabel]; if (d) { var sp = d.querySelector('.gl-text'); sp.setAttribute('contenteditable', 'true'); sp.focus(); } }, 30);
    toast('Label added — type your text, click away when done');
  };
  document.getElementById('g-del-step').onclick = deleteCurrentStep;
  function deleteCurrentStep() {
    if (guide.steps.length <= 1) { toast('Keep at least one step'); return; }
    if (!confirm('Delete this whole step from the guide?')) return;
    var i = stepAt(timeMs);
    guide.steps.splice(i, 1);
    recompute(); buildChips();
    seekStep(Math.min(i, guide.steps.length - 1));
    markDirty(); refreshTweak(); toast('Step deleted');
  }

  function refreshTweak() { if (window.guideoTweak && window.guideoTweak.refresh) window.guideoTweak.refresh(); }
  function toast(msg) { el.toast.textContent = msg; el.toast.classList.add('show'); setTimeout(function () { el.toast.classList.remove('show'); }, 2000); }

  // ---- Init + public API ----
  recompute(); applyTheme(); buildChips(); render(0);
  if (savedGuide) toast('Restored your saved edits');

  var ready = (function () {
    var ps = guide.steps.map(function (s) {
      return new Promise(function (res) { var im = new Image(); im.onload = im.onerror = res; im.src = s.image; });
    });
    return Promise.all(ps);
  })();

  window.guideo = {
    ready: ready, fps: FPS, stageSelector: '#stage',
    duration: function () { return total; },
    seek: seek, play: play, pause: pause, goToStep: seekStep,
    getGuide: function () { return guide; },
    currentStepIndex: function () { return stepAt(timeMs); },
    loadGuide: function (g) { guide = normalize(g); recompute(); applyTheme(); buildChips(); timeMs = Math.min(timeMs, total); render(timeMs); refreshTweak(); },
    rerender: function () { recompute(); applyTheme(); buildChips(); render(timeMs); markDirty(); },
    setEdit: setEdit, isEditing: function () { return editMode; },
    addHighlight: function () { document.getElementById('g-add-box').click(); },
    addLabel: function () { document.getElementById('g-add-label').click(); },
    deleteCurrentStep: deleteCurrentStep,
    deleteSelected: deleteSelected,
    save: function () { saveNow(false); }, revert: revert, markDirty: markDirty,
    toast: toast,
  };
})();
