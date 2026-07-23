/* Guideo Tweak panel — edit every bit of text, image, animation and timing
   with dropdowns and fields. Mutates the live guide and previews instantly. */
(function () {
  'use strict';
  var panel = document.getElementById('g-tweak');
  var toggle = document.getElementById('g-tweak-toggle');
  var selected = 0;

  var ANIMS = ['none', 'fade', 'kenburns-in', 'kenburns-out', 'pan-left', 'pan-right'];
  var FONTS = [
    ["'Inter', system-ui, sans-serif", 'Inter / System'],
    ["Georgia, 'Times New Roman', serif", 'Georgia (serif)'],
    ["'Courier New', monospace", 'Monospace'],
    ["'Trebuchet MS', sans-serif", 'Trebuchet'],
  ];

  function g() { return window.guideo.getGuide(); }
  function preview() { window.guideo.rerender(); window.guideo.goToStep(selected); }

  toggle.onclick = function () {
    var open = panel.classList.toggle('open');
    toggle.classList.toggle('on', open);
    if (open) build();
  };

  function field(labelText, control, hint) {
    var f = document.createElement('div'); f.className = 'f';
    var l = document.createElement('label'); l.textContent = labelText; f.appendChild(l);
    f.appendChild(control);
    if (hint) { var h = document.createElement('div'); h.className = 'hint'; h.textContent = hint; f.appendChild(h); }
    return f;
  }
  function input(type, value, on) {
    var i = document.createElement('input'); i.type = type; i.value = value;
    i.oninput = function () { on(i.value); }; return i;
  }
  function textarea(value, on) {
    var t = document.createElement('textarea'); t.value = value;
    t.oninput = function () { on(t.value); }; return t;
  }
  function select(options, value, on) {
    var s = document.createElement('select');
    options.forEach(function (o) {
      var val = Array.isArray(o) ? o[0] : o, lab = Array.isArray(o) ? o[1] : o;
      var opt = document.createElement('option'); opt.value = val; opt.textContent = lab;
      if (val === value) opt.selected = true; s.appendChild(opt);
    });
    s.onchange = function () { on(s.value); }; return s;
  }
  function range(min, max, step, value, on) {
    var i = document.createElement('input'); i.type = 'range';
    i.min = min; i.max = max; i.step = step; i.value = value;
    i.oninput = function () { on(parseFloat(i.value)); }; return i;
  }
  function section(title, openByDefault) {
    var d = document.createElement('details'); d.className = 'tw-section'; d.open = !!openByDefault;
    var s = document.createElement('summary');
    s.innerHTML = title + '<span class="caret">▸</span>'; d.appendChild(s);
    var body = document.createElement('div'); body.className = 'tw-fields'; d.appendChild(body);
    d._body = body; return d;
  }
  function btn(label, cls, on) {
    var b = document.createElement('button'); b.className = 'mini ' + (cls || '');
    b.textContent = label; b.onclick = on; return b;
  }

  function build() {
    panel.innerHTML = '';
    var head = document.createElement('header');
    head.innerHTML = '✦ Tweak studio<span class="spacer"></span>';
    var close = document.createElement('button'); close.className = 'mini'; close.textContent = 'Close';
    close.onclick = function () { panel.classList.remove('open'); toggle.classList.remove('on'); };
    head.appendChild(close); panel.appendChild(head);

    var body = document.createElement('div'); body.className = 'body'; panel.appendChild(body);

    // ---- Guide + Style ----
    var styleSec = section('🎨 Guide &amp; style', true);
    var gd = g();
    styleSec._body.appendChild(field('Guide title', input('text', gd.meta.title, function (v) { gd.meta.title = v; window.guideo.rerender(); })));
    styleSec._body.appendChild(field('Accent colour', input('color', gd.theme.accent, function (v) { gd.theme.accent = v; window.guideo.rerender(); })));
    styleSec._body.appendChild(field('Caption text colour', input('color', hex(gd.theme.captionColor), function (v) { gd.theme.captionColor = v; window.guideo.rerender(); })));
    styleSec._body.appendChild(field('Cursor colour', input('color', hex(gd.theme.cursorColor), function (v) { gd.theme.cursorColor = v; window.guideo.rerender(); })));
    styleSec._body.appendChild(field('Font', select(FONTS, gd.theme.font, function (v) { gd.theme.font = v; window.guideo.rerender(); })));
    body.appendChild(styleSec);

    // ---- Steps ----
    var stepSec = section('🎬 Steps', true);
    var picker = document.createElement('div'); picker.className = 'f';
    var pl = document.createElement('label'); pl.textContent = 'Editing step'; picker.appendChild(pl);
    var psel = document.createElement('select');
    psel.onchange = function () { selected = parseInt(psel.value, 10); renderStepFields(); window.guideo.goToStep(selected); };
    picker.appendChild(psel);
    stepSec._body.appendChild(picker);
    var stepFields = document.createElement('div');
    stepSec._body.appendChild(stepFields);
    body.appendChild(stepSec);

    function refillPicker() {
      psel.innerHTML = '';
      g().steps.forEach(function (s, i) {
        var o = document.createElement('option'); o.value = i;
        o.textContent = (i + 1) + '. ' + (s.title || 'Step');
        if (i === selected) o.selected = true; psel.appendChild(o);
      });
    }

    function renderStepFields() {
      var steps = g().steps;
      if (selected >= steps.length) selected = steps.length - 1;
      if (selected < 0) selected = 0;
      var st = steps[selected];
      stepFields.innerHTML = '';

      var thumb = document.createElement('img'); thumb.className = 'thumb'; thumb.src = st.image; stepFields.appendChild(thumb);

      stepFields.appendChild(field('Title', input('text', st.title, function (v) { st.title = v; refillPicker(); window.guideo.rerender(); })));
      stepFields.appendChild(field('Caption', textarea(st.caption, function (v) { st.caption = v; window.guideo.rerender(); })));
      stepFields.appendChild(field('Animation', select(ANIMS, st.animation, function (v) { st.animation = v; preview(); })));

      var durWrap = document.createElement('div');
      var durLabel = document.createElement('div'); durLabel.className = 'hint'; durLabel.textContent = (st.durationMs / 1000).toFixed(1) + ' s on screen';
      durWrap.appendChild(range(1000, 9000, 100, st.durationMs, function (v) { st.durationMs = v; durLabel.textContent = (v / 1000).toFixed(1) + ' s on screen'; window.guideo.rerender(); }));
      durWrap.appendChild(durLabel);
      stepFields.appendChild(field('Duration', durWrap));

      // Cursor
      var curToggle = select([['off', 'Hidden'], ['on', 'Shown']], st.cursor ? 'on' : 'off', function (v) {
        st.cursor = v === 'on' ? (st.cursor || { x: 0.5, y: 0.5, click: true }) : null;
        renderStepFields(); preview();
      });
      stepFields.appendChild(field('Pointer', curToggle));
      if (st.cursor) {
        var cx = document.createElement('div'); cx.className = 'f row2';
        cx.appendChild(range(0, 1, 0.01, st.cursor.x, function (v) { st.cursor.x = v; preview(); }));
        cx.appendChild(range(0, 1, 0.01, st.cursor.y, function (v) { st.cursor.y = v; preview(); }));
        stepFields.appendChild(field('Pointer X / Y', cx, 'Drag to move the pointer over the frame'));
        stepFields.appendChild(field('Click ripple', select([['on', 'On'], ['off', 'Off']], st.cursor.click ? 'on' : 'off', function (v) { st.cursor.click = v === 'on'; preview(); })));
      }

      // Highlight boxes (multiple)
      if (!st.highlights) st.highlights = st.highlight ? [st.highlight] : [];
      var addBox = btn('＋ Add highlight box', '', function () {
        st.highlights.push({ x: 0.38, y: 0.4, w: 0.24, h: 0.16 });
        renderStepFields(); preview();
      });
      stepFields.appendChild(field('Highlight boxes', addBox, 'Or click “✎ Edit layout” at the top to drag boxes right on the video.'));
      st.highlights.forEach(function (h, bi) {
        var box = document.createElement('div');
        box.style.cssText = 'border-top:1px solid var(--g-line);padding-top:10px;margin-top:2px';
        var hxy = document.createElement('div'); hxy.className = 'f row2';
        hxy.appendChild(range(0, 1, 0.01, h.x, function (v) { h.x = v; preview(); }));
        hxy.appendChild(range(0, 1, 0.01, h.y, function (v) { h.y = v; preview(); }));
        box.appendChild(field('Box ' + (bi + 1) + ' · X / Y', hxy));
        var hwh = document.createElement('div'); hwh.className = 'f row2';
        hwh.appendChild(range(0.03, 1, 0.01, h.w, function (v) { h.w = v; preview(); }));
        hwh.appendChild(range(0.03, 1, 0.01, h.h, function (v) { h.h = v; preview(); }));
        box.appendChild(field('Box ' + (bi + 1) + ' · W / H', hwh));
        box.appendChild(field('', btn('🗑 Remove box ' + (bi + 1), 'danger', function () { st.highlights.splice(bi, 1); renderStepFields(); preview(); })));
        stepFields.appendChild(box);
      });

      // Caption placement
      var capMode = st.captionBox ? 'custom' : (st.captionPos === 'top' ? 'top' : 'bottom');
      var capSel = select([['bottom', 'Auto — bottom'], ['top', 'Auto — top'], ['custom', 'Custom (move & resize)']], capMode, function (v) {
        if (v === 'custom') { if (!st.captionBox) st.captionBox = { x: 0.06, y: 0.8, w: 0.88 }; }
        else { st.captionBox = null; st.captionPos = v; }
        renderStepFields(); preview();
      });
      stepFields.appendChild(field('Caption position', capSel));
      if (st.captionBox) {
        var cb = st.captionBox;
        var cxy = document.createElement('div'); cxy.className = 'f row2';
        cxy.appendChild(range(0, 1, 0.01, cb.x, function (v) { cb.x = v; preview(); }));
        cxy.appendChild(range(0, 1, 0.01, cb.y, function (v) { cb.y = v; preview(); }));
        stepFields.appendChild(field('Caption X / Y', cxy));
        stepFields.appendChild(field('Caption width', range(0.2, 1, 0.01, cb.w, function (v) { cb.w = v; preview(); })));
      }

      // Replace image
      var file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*';
      file.onchange = function () {
        var fr = new FileReader();
        fr.onload = function () { st.image = fr.result; renderStepFields(); window.guideo.rerender(); window.guideo.toast('Image replaced'); };
        if (file.files[0]) fr.readAsDataURL(file.files[0]);
      };
      stepFields.appendChild(field('Replace screenshot', file, 'Swap in your own image (PNG/JPG)'));

      // Reorder / delete
      var actions = document.createElement('div'); actions.className = 'minibtns';
      actions.appendChild(btn('↑ Move up', '', function () { move(-1); }));
      actions.appendChild(btn('↓ Move down', '', function () { move(1); }));
      actions.appendChild(btn('＋ Duplicate', '', function () { duplicate(); }));
      actions.appendChild(btn('🗑 Delete', 'danger', function () { removeStep(); }));
      stepFields.appendChild(field('Order', actions));
    }

    function move(dir) {
      var steps = g().steps; var j = selected + dir;
      if (j < 0 || j >= steps.length) return;
      var tmp = steps[selected]; steps[selected] = steps[j]; steps[j] = tmp;
      selected = j; refillPicker(); renderStepFields(); preview();
    }
    function duplicate() {
      var steps = g().steps;
      var copy = JSON.parse(JSON.stringify(steps[selected]));
      copy.id = 's' + Date.now();
      steps.splice(selected + 1, 0, copy);
      selected += 1; refillPicker(); renderStepFields(); preview();
    }
    function removeStep() {
      var steps = g().steps;
      if (steps.length <= 1) { window.guideo.toast('Keep at least one step'); return; }
      steps.splice(selected, 1);
      if (selected >= steps.length) selected = steps.length - 1;
      refillPicker(); renderStepFields(); preview();
    }

    refillPicker(); renderStepFields();

    // ---- Save / Export ----
    var exp = document.createElement('div'); exp.className = 'export-row';
    exp.appendChild(btn('💾 Save', '', function () { window.guideo.save(); }));
    exp.appendChild(btn('↺ Revert', 'danger', function () {
      if (confirm('Discard your saved edits and reload the original guide?')) window.guideo.revert();
    }));
    exp.appendChild(btn('⬇ guide.json', '', downloadJson));
    exp.appendChild(btn('⬇ player.html', '', downloadHtml));
    exp.appendChild(btn('⧉ Copy JSON', '', copyJson));
    panel.appendChild(exp);

    window.guideoTweak = {
      refresh: function () {
        // Follow the step shown on the canvas while editing the layout.
        if (window.guideo.isEditing && window.guideo.isEditing()) selected = window.guideo.currentStepIndex();
        refillPicker(); renderStepFields();
      },
    };
  }

  function hex(c) {
    if (!c) return '#ffffff';
    if (c[0] === '#') return c.slice(0, 7);
    var m = c.match(/\d+/g);
    if (!m) return '#ffffff';
    return '#' + m.slice(0, 3).map(function (n) { return ('0' + parseInt(n, 10).toString(16)).slice(-2); }).join('');
  }
  function download(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function downloadJson() {
    download('guide.json', new Blob([JSON.stringify(g(), null, 2)], { type: 'application/json' }));
    window.guideo.toast('Downloaded guide.json');
  }
  function copyJson() {
    navigator.clipboard.writeText(JSON.stringify(g(), null, 2)).then(function () { window.guideo.toast('Copied to clipboard'); });
  }
  function downloadHtml() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelector('#guide-data').textContent = JSON.stringify(g());
    var appClone = clone.querySelector('#app'); if (appClone) appClone.innerHTML = '';
    var tw = clone.querySelector('#g-tweak'); if (tw) { tw.className = 'tweak'; tw.innerHTML = ''; }
    download('player.html', new Blob(['<!DOCTYPE html>\n' + clone.outerHTML], { type: 'text/html' }));
    window.guideo.toast('Downloaded player.html');
  }
})();
