/* Guideo player runtime — deterministic playback so the MP4 renderer can seek
   to any millisecond and screenshot an identical frame. No wall-clock reads
   inside render(); play() only advances a clock that feeds render(). */
(function () {
  'use strict';
  var FADE = 450; // crossfade duration between steps (ms)
  var FPS = 30;

  var guide = JSON.parse(document.getElementById('guide-data').textContent);
  var app = document.getElementById('app');

  // ---- Build DOM ----
  app.innerHTML =
    '<div class="main">' +
      '<div class="topbar">' +
        '<span class="logo"><span class="dot"></span> Guideo</span>' +
        '<span class="title" id="g-title"></span>' +
        '<span class="spacer"></span>' +
        '<button class="tbtn" id="g-tweak-toggle">✦ Tweak</button>' +
      '</div>' +
      '<div class="stage-wrap"><div class="stage" id="stage">' +
        '<div class="layer" id="g-prev"></div>' +
        '<div class="layer" id="g-cur"></div>' +
        '<div class="spotlight" id="g-spot" style="display:none"></div>' +
        '<div class="ripple" id="g-ripple" style="display:none"></div>' +
        '<div class="cursor" id="g-cursor" style="display:none">' +
          '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M5 3l14.5 6.6c.9.4.8 1.7-.1 2L13 13.4l-2.6 6.4c-.4.9-1.7.8-2-.1L5 3.9c-.2-.7.4-1.2 1-.9z" fill="#fff" stroke="#0b0c14" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
        '</div>' +
        '<div class="caption" id="g-caption"></div>' +
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
    spot: document.getElementById('g-spot'),
    ripple: document.getElementById('g-ripple'),
    cursor: document.getElementById('g-cursor'),
    caption: document.getElementById('g-caption'),
    stage: document.getElementById('stage'),
    fill: document.getElementById('g-fill'),
    ticks: document.getElementById('g-ticks'),
    time: document.getElementById('g-time'),
    track: document.getElementById('g-track'),
    strip: document.getElementById('g-strip'),
    play: document.getElementById('g-play'),
    toast: document.getElementById('g-toast'),
  };

  // ---- State ----
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
    for (var j = 0; j < guide.steps.length; j++) {
      var img = new Image();
      img.src = guide.steps[j].image;
    }
  }

  function stepAt(t) {
    var i = 0;
    for (var k = 0; k < starts.length; k++) if (starts[k] <= t) i = k;
    return i;
  }
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

  function render(t) {
    t = Math.max(0, Math.min(total, t));
    var i = stepAt(t);
    var step = guide.steps[i];
    var local = t - starts[i];
    var dur = Math.max(300, step.durationMs || 3500);
    var p = local / dur;
    var fade = i === 0 ? 1 : Math.max(0, Math.min(1, local / FADE));

    el.cur.style.backgroundImage = 'url("' + step.image + '")';
    el.cur.style.opacity = fade;
    el.cur.style.transform = animTransform(step.animation, p);
    el.cur.style.transformOrigin = 'center center';

    if (i > 0 && fade < 1) {
      var prev = guide.steps[i - 1];
      el.prev.style.display = '';
      el.prev.style.backgroundImage = 'url("' + prev.image + '")';
      el.prev.style.transform = animTransform(prev.animation, 1);
    } else {
      el.prev.style.display = 'none';
    }

    // caption
    var lead = step.title ? '<span class="lead">' + escapeHtml(step.title) + '</span>' : '';
    el.caption.innerHTML = lead + escapeHtml(step.caption || '');
    el.caption.style.opacity = fade;
    el.caption.style.display = step.caption || step.title ? '' : 'none';
    el.caption.classList.toggle('top', step.captionPos === 'top');

    // cursor + ripple
    if (step.cursor) {
      el.cursor.style.display = '';
      el.cursor.style.left = (step.cursor.x * 100) + '%';
      el.cursor.style.top = (step.cursor.y * 100) + '%';
      el.cursor.style.opacity = fade;
      if (step.cursor.click) {
        var rp = (local % 1600) / 1600;
        el.ripple.style.display = '';
        el.ripple.style.left = (step.cursor.x * 100) + '%';
        el.ripple.style.top = (step.cursor.y * 100) + '%';
        el.ripple.style.transform = 'scale(' + (0.5 + rp * 0.85) + ')';
        el.ripple.style.opacity = (1 - rp) * 0.45 * fade;
      } else { el.ripple.style.display = 'none'; }
    } else {
      el.cursor.style.display = 'none';
      el.ripple.style.display = 'none';
    }

    // highlight
    if (step.highlight) {
      var h = step.highlight;
      el.spot.style.display = '';
      el.spot.style.left = (h.x * 100) + '%';
      el.spot.style.top = (h.y * 100) + '%';
      el.spot.style.width = (h.w * 100) + '%';
      el.spot.style.height = (h.h * 100) + '%';
      el.spot.style.opacity = fade;
    } else {
      el.spot.style.display = 'none';
    }

    // controls
    el.fill.style.width = (t / total * 100) + '%';
    el.time.textContent = fmt(t) + ' / ' + fmt(total);
    el.title.textContent = guide.meta ? guide.meta.title : '';
    var chips = el.strip.children;
    for (var c = 0; c < chips.length; c++) chips[c].className = 'chip' + (c === i ? ' active' : '');
  }

  function fmt(ms) {
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  // ---- Playback ----
  function loop(ts) {
    if (!playing) return;
    if (!lastFrame) lastFrame = ts;
    var dt = ts - lastFrame;
    lastFrame = ts;
    timeMs += dt;
    if (timeMs >= total) { timeMs = total; pause(); render(timeMs); el.play.textContent = '↻'; return; }
    render(timeMs);
    requestAnimationFrame(loop);
  }
  function play() {
    if (timeMs >= total) timeMs = 0;
    playing = true; lastFrame = 0; el.play.textContent = '❚❚';
    requestAnimationFrame(loop);
  }
  function pause() { playing = false; el.play.textContent = '▶'; }
  function toggle() { playing ? pause() : play(); }
  function seek(ms) { pause(); timeMs = Math.max(0, Math.min(total, ms)); render(timeMs); el.play.textContent = timeMs >= total ? '↻' : '▶'; }
  function seekStep(i) { seek(starts[Math.max(0, Math.min(starts.length - 1, i))] + 1); }

  el.play.onclick = toggle;
  document.getElementById('g-prev-btn').onclick = function () { seekStep(stepAt(timeMs) - 1); };
  document.getElementById('g-next-btn').onclick = function () { seekStep(stepAt(timeMs) + 1); };
  el.track.onclick = function (e) {
    var r = el.track.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * total);
  };
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowRight') seekStep(stepAt(timeMs) + 1);
    else if (e.code === 'ArrowLeft') seekStep(stepAt(timeMs) - 1);
  });

  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('show');
    setTimeout(function () { el.toast.classList.remove('show'); }, 1800);
  }

  // ---- Init + public API ----
  recompute(); applyTheme(); buildChips(); render(0);

  var ready = (function () {
    var ps = guide.steps.map(function (s) {
      return new Promise(function (res) {
        var im = new Image();
        im.onload = im.onerror = res;
        im.src = s.image;
      });
    });
    return Promise.all(ps);
  })();

  window.guideo = {
    ready: ready,
    fps: FPS,
    stageSelector: '#stage',
    duration: function () { return total; },
    seek: seek,
    play: play,
    pause: pause,
    getGuide: function () { return guide; },
    loadGuide: function (g) {
      guide = g;
      recompute(); applyTheme(); buildChips();
      timeMs = Math.min(timeMs, total); render(timeMs);
      if (window.guideoTweak) window.guideoTweak.refresh();
    },
    rerender: function () {
      recompute(); applyTheme(); buildChips(); render(timeMs);
    },
    toast: toast,
    goToStep: seekStep,
  };
})();
