/**
 * Turn a guide into a static, multi-page documentation site styled after the
 * Makina docs (a Vocs theme): left sidebar, content column, right "on this
 * page" rail, teal accent, light/dark. One page per section (see
 * guide-sections.ts). No build step — plain HTML/CSS/JS, so it previews
 * instantly and deploys to Vercel as static files.
 *
 * Returns an in-memory file tree so the same output can be written to disk for
 * a local preview or handed straight to the Vercel deploy tool.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Guide, Step } from './types.js';
import { groupSteps, type GuideSection } from './guide-sections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, 'docsite-assets');

export interface SiteFile {
  file: string;
  data: string; // utf-8 text, or base64 for binary
  encoding?: 'utf-8' | 'base64';
}

interface DecodedImg { buf: Buffer; ext: string; }
function decodeImage(ref: string | undefined, guideDir?: string): DecodedImg | null {
  if (!ref) return null;
  if (ref.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(ref);
    if (!m) return null;
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    return { buf: Buffer.from(m[2], 'base64'), ext };
  }
  if (guideDir) {
    const abs = path.isAbsolute(ref) ? ref : path.join(guideDir, ref);
    if (existsSync(abs)) return { buf: readFileSync(abs), ext: (path.extname(abs).slice(1) || 'png').toLowerCase() };
  }
  return null;
}

function esc(s: string | undefined): string {
  return String(s || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]!));
}
function clean(s: string | undefined): string { return String(s || '').replace(/\s+/g, ' ').trim(); }
function pad(n: number): string { return String(n).padStart(2, '0'); }
/** The step's own heading: the part after "Section: …", else the full title. */
function stepHeading(step: Step, i: number): string {
  const t = clean(step.title);
  const m = /^.{2,60}?:\s*(\S.*)$/.exec(t);
  return (m ? m[1] : t) || 'Step ' + (i + 1);
}

function css(): string {
  return `
:root{
  color-scheme: light dark;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  --bg: light-dark(#e3e3e3, #0f172a);
  --surface: light-dark(#f1f1f1, #1e293b);
  --surface-muted: light-dark(#e9e9e9, #172033);
  --text: light-dark(#1e293b, #ecfeff);
  --muted: light-dark(#6b6b7b, #7e8b95);
  --accent: light-dark(#0891b2, #3dc9de);
  --accent-hover: light-dark(#0779a0, #23bdd5);
  --border: light-dark(#dddddd, #273243);
  --shadow: light-dark(0 6px 24px rgba(0,0,0,.10), 0 6px 24px rgba(0,0,0,.5));
  --sidebar: 288px; --toc: 232px; --nav-h: 60px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth; scroll-padding-top:calc(var(--nav-h) + 16px)}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  -webkit-font-smoothing:antialiased;line-height:1.65;font-size:16px}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}
img{max-width:100%}
.nav{position:sticky;top:0;z-index:20;height:var(--nav-h);display:flex;align-items:center;gap:16px;
  padding:0 22px;background:color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter:saturate(1.1) blur(8px);border-bottom:1px solid var(--border)}
.nav .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:var(--text)}
.nav .brand img{height:26px;width:auto}
.nav .spacer{flex:1}
.nav .navlinks{display:flex;gap:18px}
.nav .navlinks a{color:var(--muted);font-size:14px;font-weight:600}
.nav .navlinks a:hover{color:var(--text)}
.icons{display:flex;gap:6px;align-items:center}
.iconbtn{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--surface);
  color:var(--muted);cursor:pointer;display:grid;place-items:center;font-size:15px}
.iconbtn:hover{color:var(--text);border-color:var(--accent)}
.wrap{max-width:1400px;margin:0 auto;display:grid;
  grid-template-columns:var(--sidebar) minmax(0,1fr) var(--toc);gap:0}
.sidebar{border-right:1px solid var(--border);padding:22px 18px 60px;
  position:sticky;top:var(--nav-h);align-self:start;height:calc(100vh - var(--nav-h));overflow-y:auto}
.sidebar .sect{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:700;margin:14px 8px 8px}
.sidebar a{display:block;padding:7px 10px;border-radius:8px;color:var(--muted);font-size:14px;font-weight:500}
.sidebar a:hover{background:var(--surface);color:var(--text)}
.sidebar a.active{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:600}
.sidebar .sub{margin:2px 0 6px 8px;border-left:1px solid var(--border);padding-left:6px}
.sidebar .sub a{font-size:13px;padding:5px 10px;color:var(--muted)}
.sidebar .sub a.active{background:transparent;color:var(--accent)}
.content{padding:34px 46px 90px;min-width:0}
.hero{display:flex;align-items:center;gap:18px;margin-bottom:6px}
.hero img{height:52px}
.content h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:.2em 0 .2em}
.eyebrow{color:var(--accent);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.lede{color:var(--muted);font-size:18px;margin:0 0 10px}
.meta-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0 8px}
.pill{font-size:12.5px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:4px 11px;background:var(--surface)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#04222a;
  border-radius:10px;padding:9px 15px;font-weight:700;font-size:14px}
.btn:hover{background:var(--accent-hover);color:#04222a}
.videowrap{margin:18px 0 6px;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:#000;box-shadow:var(--shadow)}
.videowrap video{display:block;width:100%}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:18px 0}
.card{display:block;border:1px solid var(--border);border-radius:12px;padding:16px 16px;background:var(--surface)}
.card:hover{border-color:var(--accent)}
.card .n{color:var(--accent);font-weight:800;font-size:13px}
.card .h{font-weight:700;margin:4px 0 3px;color:var(--text);font-size:16px}
.card .d{color:var(--muted);font-size:13px}
.step{padding-top:26px;margin-top:20px;border-top:1px solid var(--border)}
.step:first-of-type{border-top:none}
.step h2{font-size:23px;letter-spacing:-.01em;margin:.1em 0 .35em;scroll-margin-top:calc(var(--nav-h) + 14px)}
.step .num{color:var(--accent);font-weight:800;margin-right:.4em}
.step p{margin:.2em 0 .9em;color:var(--text)}
.shot{border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);background:var(--surface)}
.shot img{display:block;width:100%}
.callout{display:flex;gap:10px;background:var(--surface-muted);border:1px solid var(--border);
  border-left:3px solid var(--accent);border-radius:10px;padding:12px 14px;margin:16px 0;color:var(--text)}
.callout .ic{color:var(--accent);font-weight:800}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:40px;border-top:1px solid var(--border);padding-top:18px}
.pager a{display:block;border:1px solid var(--border);border-radius:12px;padding:12px 16px;min-width:0;background:var(--surface)}
.pager a:hover{border-color:var(--accent)}
.pager .dir{color:var(--muted);font-size:12px}
.pager .pg-title{color:var(--text);font-weight:600}
.pager .next{text-align:right;margin-left:auto}
.toc{position:sticky;top:var(--nav-h);align-self:start;height:calc(100vh - var(--nav-h));
  overflow-y:auto;padding:34px 18px;border-left:1px solid var(--border)}
.toc .t{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:10px}
.toc a{display:block;padding:5px 10px;border-left:2px solid transparent;color:var(--muted);font-size:13px;line-height:1.4}
.toc a:hover{color:var(--text)}
.toc a.active{border-left-color:var(--accent);color:var(--accent)}
footer{color:var(--muted);font-size:13px;margin-top:40px;border-top:1px solid var(--border);padding-top:18px}
.menu-toggle{display:none}
@media (max-width:1100px){.wrap{grid-template-columns:var(--sidebar) minmax(0,1fr)}.toc{display:none}}
@media (max-width:820px){
  .wrap{grid-template-columns:1fr}
  .sidebar{position:fixed;top:var(--nav-h);left:0;width:82%;max-width:320px;background:var(--bg);
    height:calc(100vh - var(--nav-h));z-index:15;transform:translateX(-105%);transition:transform .2s;box-shadow:var(--shadow)}
  body.menu-open .sidebar{transform:none}
  .menu-toggle{display:grid}
  .content{padding:24px 20px 80px}.content h1{font-size:30px}
}
@media (prefers-color-scheme: dark){.only-light{display:none!important}.only-dark{display:inline!important}}
:root[style*="color-scheme: dark"] .only-light{display:none!important}:root[style*="color-scheme: dark"] .only-dark{display:inline!important}
:root[style*="color-scheme: light"] .only-light{display:inline!important}:root[style*="color-scheme: light"] .only-dark{display:none!important}
`.trim();
}

function themeJs(): string {
  return `
(function(){
  var root=document.documentElement;
  function apply(t){ root.style.colorScheme=t; try{localStorage.setItem('guideo-docs-theme',t)}catch(e){} }
  var saved; try{saved=localStorage.getItem('guideo-docs-theme')}catch(e){}
  if(saved) apply(saved);
  var btn=document.getElementById('theme-btn');
  if(btn) btn.onclick=function(){
    var cur=getComputedStyle(root).colorScheme;
    var isDark = cur.indexOf('dark')===0 || (cur==='light dark' && matchMedia('(prefers-color-scheme: dark)').matches);
    apply(isDark?'light':'dark');
  };
  var mt=document.getElementById('menu-btn');
  if(mt) mt.onclick=function(){ document.body.classList.toggle('menu-open'); };
  var links=[].slice.call(document.querySelectorAll('[data-spy]'));
  var ids=links.map(function(a){return a.getAttribute('href').split('#')[1];}).filter(Boolean);
  function onScroll(){
    var y=window.scrollY+(parseInt(getComputedStyle(root).getPropertyValue('--nav-h'))||60)+24;
    var cur=ids[0];
    for(var i=0;i<ids.length;i++){ var el=document.getElementById(ids[i]); if(el && el.offsetTop<=y) cur=ids[i]; }
    links.forEach(function(a){ a.classList.toggle('active', a.getAttribute('href').split('#')[1]===cur); });
  }
  if(ids.length){ window.addEventListener('scroll',onScroll,{passive:true}); onScroll(); }
})();
`.trim();
}

export interface DocsiteInput {
  guide: Guide;
  guideDir?: string;
  mp4?: Buffer | null;
}

function logoTag(cls = ''): string {
  return '<img src="img/logo-light.svg" alt="" class="only-light' + (cls ? ' ' + cls : '') + '">' +
         '<img src="img/logo-dark.svg" alt="" class="only-dark' + (cls ? ' ' + cls : '') + '" style="display:none">';
}

/** Build the static, multi-page docs site as an in-memory file tree. */
export function buildDocsite(input: DocsiteInput): SiteFile[] {
  const { guide } = input;
  const meta = guide.meta || ({} as any);
  const files: SiteFile[] = [];
  const sections = groupSteps(guide);

  const logoLight = existsSync(path.join(ASSETS, 'logo-light.svg')) ? readFileSync(path.join(ASSETS, 'logo-light.svg')) : null;
  const logoDark = existsSync(path.join(ASSETS, 'logo-dark.svg')) ? readFileSync(path.join(ASSETS, 'logo-dark.svg')) : null;
  const favicon = existsSync(path.join(ASSETS, 'favicon.ico')) ? readFileSync(path.join(ASSETS, 'favicon.ico')) : null;
  if (logoLight) files.push({ file: 'img/logo-light.svg', data: logoLight.toString('base64'), encoding: 'base64' });
  if (logoDark) files.push({ file: 'img/logo-dark.svg', data: logoDark.toString('base64'), encoding: 'base64' });
  if (favicon) files.push({ file: 'favicon.ico', data: favicon.toString('base64'), encoding: 'base64' });

  const hasLogo = !!logoLight;
  const imgNames: (string | null)[] = [];
  guide.steps.forEach((s, i) => {
    const img = decodeImage(s.image, input.guideDir);
    if (img) {
      const name = 'assets/step-' + pad(i + 1) + '.' + img.ext;
      files.push({ file: name, data: img.buf.toString('base64'), encoding: 'base64' });
      imgNames.push(name);
    } else imgNames.push(null);
  });
  const hasVideo = !!input.mp4;
  if (input.mp4) files.push({ file: 'guide.mp4', data: input.mp4.toString('base64'), encoding: 'base64' });

  // Sidebar shared across pages (active = current page's slug or 'overview').
  function sidebar(active: string): string {
    let h = '<div class="sect">' + esc(clean(meta.title) || 'Guide') + '</div>';
    h += '<a href="index.html"' + (active === 'overview' ? ' class="active"' : '') + '>Overview</a>';
    sections.forEach((sec) => {
      const on = active === sec.slug;
      h += '<a href="' + sec.slug + '.html"' + (on ? ' class="active"' : '') + '>' + esc(sec.title) + '</a>';
      if (on && sec.steps.length > 1) {
        h += '<div class="sub">' + sec.steps.map((st, k) =>
          '<a href="#step-' + (sec.indices[k] + 1) + '" data-spy>' + esc(stepHeading(st, sec.indices[k])) + '</a>').join('') + '</div>';
      }
    });
    return h;
  }

  function shell(title: string, active: string, body: string, tocHtml: string): string {
    return '<!DOCTYPE html><html lang="en"><head>' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(title) + '</title>' +
      (favicon ? '<link rel="icon" href="favicon.ico">' : '') +
      '<meta name="description" content="' + esc(clean(meta.description)) + '">' +
      '<style>' + css() + '</style></head><body>' +
      '<nav class="nav">' +
      '<button class="iconbtn menu-toggle" id="menu-btn" title="Menu">☰</button>' +
      '<a class="brand" href="index.html">' + (hasLogo ? logoTag() : '') + '<span>' + esc(clean(meta.title) || 'Docs') + '</span></a>' +
      '<div class="spacer"></div>' +
      (meta.sourceUrl ? '<div class="navlinks"><a href="' + esc(meta.sourceUrl) + '" target="_blank" rel="noopener">Open the app ↗</a></div>' : '') +
      '<div class="icons"><button class="iconbtn" id="theme-btn" title="Toggle theme">◑</button></div>' +
      '</nav><div class="wrap">' +
      '<aside class="sidebar">' + sidebar(active) + '</aside>' +
      '<main class="content">' + body + '</main>' +
      '<aside class="toc">' + (tocHtml || '') + '</aside>' +
      '</div><script>' + themeJs() + '</script></body></html>';
  }

  function pager(prev: { href: string; title: string } | null, next: { href: string; title: string } | null): string {
    if (!prev && !next) return '';
    return '<div class="pager">' +
      (prev ? '<a class="prev" href="' + prev.href + '"><div class="dir">← Previous</div><div class="pg-title">' + esc(prev.title) + '</div></a>' : '<span></span>') +
      (next ? '<a class="next" href="' + next.href + '"><div class="dir">Next →</div><div class="pg-title">' + esc(next.title) + '</div></a>' : '') +
      '</div>';
  }

  // ---- Overview (index.html) ----
  const overviewBody =
    '<div class="hero">' + (hasLogo ? logoTag() : '') + '<div><h1>' + esc(clean(meta.title) || 'Guide') + '</h1></div></div>' +
    (clean(meta.description) ? '<p class="lede">' + esc(clean(meta.description)) + '</p>' : '') +
    '<div class="meta-row"><span class="pill">' + guide.steps.length + ' steps</span>' +
    '<span class="pill">' + sections.length + ' section' + (sections.length === 1 ? '' : 's') + '</span>' +
    (meta.site ? '<span class="pill">' + esc(clean(meta.site)) + '</span>' : '') +
    (hasVideo ? '<a class="btn" href="guide.mp4">▶ Watch the video</a>' : '') + '</div>' +
    (hasVideo ? '<div class="videowrap"><video src="guide.mp4" controls preload="metadata" playsinline></video></div>' : '') +
    '<div class="callout"><span class="ic">i</span><div>This guide is split into ' + sections.length + ' section' + (sections.length === 1 ? '' : 's') + '. Start below, or pick a section from the sidebar.</div></div>' +
    '<h2 style="margin-top:26px">Contents</h2>' +
    '<div class="cards">' + sections.map((sec, i) =>
      '<a class="card" href="' + sec.slug + '.html"><div class="n">Section ' + (i + 1) + '</div>' +
      '<div class="h">' + esc(sec.title) + '</div>' +
      '<div class="d">' + sec.steps.length + ' step' + (sec.steps.length === 1 ? '' : 's') + '</div></a>').join('') +
    '</div>' +
    pager(null, sections[0] ? { href: sections[0].slug + '.html', title: sections[0].title } : null) +
    '<footer>Generated with Guideo' + (meta.sourceUrl ? ' · <a href="' + esc(meta.sourceUrl) + '" target="_blank" rel="noopener">' + esc(clean(meta.site) || meta.sourceUrl) + '</a>' : '') + '</footer>';
  files.push({ file: 'index.html', data: shell(clean(meta.title) || 'Guide', 'overview', overviewBody, ''), encoding: 'utf-8' });

  // ---- Section pages ----
  sections.forEach((sec, si) => {
    const stepsHtml = sec.steps.map((st, k) => {
      const gi = sec.indices[k];
      const cap = clean(st.caption);
      return '<section class="step" id="step-' + (gi + 1) + '">' +
        '<h2><span class="num">' + (gi + 1) + '</span>' + esc(stepHeading(st, gi)) + '</h2>' +
        (cap ? '<p>' + esc(cap) + '</p>' : '') +
        (imgNames[gi] ? '<div class="shot"><img loading="lazy" src="' + imgNames[gi] + '" alt="' + esc(stepHeading(st, gi)) + '"></div>' : '') +
        '</section>';
    }).join('\n');

    const body =
      '<div class="eyebrow">Section ' + (si + 1) + ' of ' + sections.length + '</div>' +
      '<h1>' + esc(sec.title) + '</h1>' +
      stepsHtml +
      pager(
        si === 0 ? { href: 'index.html', title: 'Overview' } : { href: sections[si - 1].slug + '.html', title: sections[si - 1].title },
        sections[si + 1] ? { href: sections[si + 1].slug + '.html', title: sections[si + 1].title } : null
      ) +
      '<footer>Generated with Guideo</footer>';

    const toc = '<div class="t">On this page</div>' +
      sec.steps.map((st, k) => '<a href="#step-' + (sec.indices[k] + 1) + '" data-spy>' + esc(stepHeading(st, sec.indices[k])) + '</a>').join('');

    files.push({ file: sec.slug + '.html', data: shell(sec.title + ' · ' + (clean(meta.title) || 'Guide'), sec.slug, body, toc), encoding: 'utf-8' });
  });

  files.push({ file: 'vercel.json', data: JSON.stringify({ cleanUrls: true, trailingSlash: false }, null, 2), encoding: 'utf-8' });
  return files;
}

/** Write a site file tree to disk. Returns the index path. */
export async function writeDocsite(files: SiteFile[], outDir: string): Promise<string> {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  // Clear a stale site so removed section pages don't linger.
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  for (const f of files) {
    const abs = path.join(outDir, f.file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  return path.join(outDir, 'index.html');
}
