/**
 * Turn a guide into a static, self-contained documentation site styled after
 * the Makina docs (a Vocs theme): left sidebar, content column, right "on this
 * page" rail, teal accent, light/dark. No build step — it's plain HTML/CSS/JS,
 * so it previews instantly and deploys to Vercel as static files.
 *
 * Returns an in-memory file tree so the same output can be written to disk for
 * a local preview or handed straight to the Vercel deploy tool.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Guide, Step } from './types.js';

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
function slugify(s: string, i: number): string {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (base || 'step') + '-' + (i + 1);
}
function pad(n: number): string { return String(n).padStart(2, '0'); }

/** The Vocs/Makina-flavoured stylesheet. */
function css(): string {
  return `
:root{
  color-scheme: light dark;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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

/* Top nav */
.nav{position:sticky;top:0;z-index:20;height:var(--nav-h);display:flex;align-items:center;gap:16px;
  padding:0 22px;background:color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter:saturate(1.1) blur(8px);border-bottom:1px solid var(--border)}
.nav .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:var(--text)}
.nav .brand img{height:26px;width:auto}
.nav .brand .word{font-weight:700}
.nav .spacer{flex:1}
.nav .navlinks{display:flex;gap:18px}
.nav .navlinks a{color:var(--muted);font-size:14px;font-weight:600}
.nav .navlinks a:hover{color:var(--text)}
.icons{display:flex;gap:6px;align-items:center}
.iconbtn{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--surface);
  color:var(--muted);cursor:pointer;display:grid;place-items:center;font-size:15px}
.iconbtn:hover{color:var(--text);border-color:var(--accent)}

/* Layout */
.wrap{max-width:1400px;margin:0 auto;display:grid;
  grid-template-columns:var(--sidebar) minmax(0,1fr) var(--toc);gap:0}
.sidebar{border-right:1px solid var(--border);padding:26px 18px 60px;
  position:sticky;top:var(--nav-h);align-self:start;height:calc(100vh - var(--nav-h));overflow-y:auto}
.sidebar .sect{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:700;margin:14px 8px 8px}
.sidebar a{display:block;padding:7px 10px;border-radius:8px;color:var(--muted);font-size:14px;font-weight:500}
.sidebar a:hover{background:var(--surface);color:var(--text)}
.sidebar a.active{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:600}

.content{padding:34px 46px 90px;min-width:0}
.hero{display:flex;align-items:center;gap:18px;margin-bottom:6px}
.hero img{height:52px}
.content h1{font-size:40px;line-height:1.1;letter-spacing:-.02em;margin:.2em 0 .2em}
.lede{color:var(--muted);font-size:18px;margin:0 0 10px}
.meta-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0 8px}
.pill{font-size:12.5px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:4px 11px;background:var(--surface)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#04222a;
  border-radius:10px;padding:9px 15px;font-weight:700;font-size:14px}
.btn:hover{background:var(--accent-hover);color:#04222a}
.videowrap{margin:18px 0 6px;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:#000;box-shadow:var(--shadow)}
.videowrap video{display:block;width:100%}

.step{padding-top:26px;margin-top:20px;border-top:1px solid var(--border)}
.step:first-of-type{border-top:none}
.step h2{font-size:24px;letter-spacing:-.01em;margin:.1em 0 .35em;scroll-margin-top:calc(var(--nav-h) + 14px)}
.step .num{color:var(--accent);font-weight:800;margin-right:.4em}
.step p{margin:.2em 0 .9em;color:var(--text)}
.shot{border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);background:var(--surface)}
.shot img{display:block;width:100%}
.callout{display:flex;gap:10px;background:var(--surface-muted);border:1px solid var(--border);
  border-left:3px solid var(--accent);border-radius:10px;padding:12px 14px;margin:16px 0;color:var(--text)}
.callout .ic{color:var(--accent);font-weight:800}

/* Right TOC */
.toc{position:sticky;top:var(--nav-h);align-self:start;height:calc(100vh - var(--nav-h));
  overflow-y:auto;padding:34px 18px;border-left:1px solid var(--border)}
.toc .t{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:10px}
.toc a{display:block;padding:5px 10px;border-left:2px solid transparent;color:var(--muted);font-size:13px;line-height:1.4}
.toc a:hover{color:var(--text)}
.toc a.active{border-left-color:var(--accent);color:var(--accent)}
footer{color:var(--muted);font-size:13px;margin-top:40px;border-top:1px solid var(--border);padding-top:18px}

.menu-toggle{display:none}
@media (max-width:1100px){
  .wrap{grid-template-columns:var(--sidebar) minmax(0,1fr)}
  .toc{display:none}
}
@media (max-width:820px){
  .wrap{grid-template-columns:1fr}
  .sidebar{position:fixed;top:var(--nav-h);left:0;width:82%;max-width:320px;background:var(--bg);
    height:calc(100vh - var(--nav-h));z-index:15;transform:translateX(-105%);transition:transform .2s;box-shadow:var(--shadow)}
  body.menu-open .sidebar{transform:none}
  .menu-toggle{display:grid}
  .content{padding:24px 20px 80px}
  .content h1{font-size:32px}
}
`.trim();
}

function themeToggleJs(): string {
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
  // Scrollspy for sidebar + TOC.
  var links=[].slice.call(document.querySelectorAll('[data-spy]'));
  var map={}; links.forEach(function(a){ (map[a.getAttribute('href').slice(1)]=map[a.getAttribute('href').slice(1)]||[]).push(a); });
  var ids=Object.keys(map);
  function onScroll(){
    var y=window.scrollY+ (parseInt(getComputedStyle(root).getPropertyValue('--nav-h'))||60) + 24;
    var cur=ids[0];
    for(var i=0;i<ids.length;i++){ var el=document.getElementById(ids[i]); if(el && el.offsetTop<=y) cur=ids[i]; }
    links.forEach(function(a){ a.classList.toggle('active', a.getAttribute('href')==='#'+cur); });
  }
  window.addEventListener('scroll',onScroll,{passive:true}); onScroll();
})();
`.trim();
}

export interface DocsiteInput {
  guide: Guide;
  guideDir?: string;
  /** Include a rendered MP4 in the site (embedded at the top). */
  mp4?: Buffer | null;
}

/** Build the static docs site as an in-memory file tree. */
export function buildDocsite(input: DocsiteInput): SiteFile[] {
  const { guide } = input;
  const meta = guide.meta || ({} as any);
  const files: SiteFile[] = [];

  // Branding assets (Makina marks + favicon), bundled with the tool.
  const logoLight = existsSync(path.join(ASSETS, 'logo-light.svg')) ? readFileSync(path.join(ASSETS, 'logo-light.svg')) : null;
  const logoDark = existsSync(path.join(ASSETS, 'logo-dark.svg')) ? readFileSync(path.join(ASSETS, 'logo-dark.svg')) : null;
  const favicon = existsSync(path.join(ASSETS, 'favicon.ico')) ? readFileSync(path.join(ASSETS, 'favicon.ico')) : null;
  if (logoLight) files.push({ file: 'img/logo-light.svg', data: logoLight.toString('base64'), encoding: 'base64' });
  if (logoDark) files.push({ file: 'img/logo-dark.svg', data: logoDark.toString('base64'), encoding: 'base64' });
  if (favicon) files.push({ file: 'favicon.ico', data: favicon.toString('base64'), encoding: 'base64' });

  // Step images.
  const imgNames: (string | null)[] = [];
  guide.steps.forEach((s: Step, i) => {
    const img = decodeImage(s.image, input.guideDir);
    if (img) {
      const name = 'assets/step-' + pad(i + 1) + '.' + img.ext;
      files.push({ file: name, data: img.buf.toString('base64'), encoding: 'base64' });
      imgNames.push(name);
    } else imgNames.push(null);
  });

  const hasVideo = !!input.mp4;
  if (input.mp4) files.push({ file: 'guide.mp4', data: input.mp4.toString('base64'), encoding: 'base64' });

  const anchors = guide.steps.map((s, i) => slugify(s.title, i));

  // Sidebar
  const sidebar =
    '<div class="sect">' + esc(clean(meta.title) || 'Guide') + '</div>' +
    '<a href="#top" data-spy>Overview</a>' +
    guide.steps.map((s, i) => '<a href="#' + anchors[i] + '" data-spy>' + (i + 1) + '. ' + esc(clean(s.title) || 'Step') + '</a>').join('');

  // Right TOC
  const toc =
    '<div class="t">On this page</div>' +
    '<a href="#top" data-spy>Overview</a>' +
    guide.steps.map((s, i) => '<a href="#' + anchors[i] + '" data-spy>' + esc(clean(s.title) || 'Step ' + (i + 1)) + '</a>').join('');

  // Content
  const stepsHtml = guide.steps.map((s, i) => {
    const cap = clean(s.caption);
    return '<section class="step" id="' + anchors[i] + '">' +
      '<h2><span class="num">' + (i + 1) + '</span>' + esc(clean(s.title) || 'Step ' + (i + 1)) + '</h2>' +
      (cap ? '<p>' + esc(cap) + '</p>' : '') +
      (imgNames[i] ? '<div class="shot"><img loading="lazy" src="' + imgNames[i] + '" alt="' + esc(clean(s.title)) + '"></div>' : '') +
      '</section>';
  }).join('\n');

  const brand =
    '<a class="brand" href="#top">' +
    (logoLight ? '<img src="img/logo-light.svg" alt="" class="only-light"><img src="img/logo-dark.svg" alt="" class="only-dark" style="display:none">' : '') +
    '<span class="word">' + esc(clean(meta.title) || 'Docs') + '</span></a>';

  const html =
'<!DOCTYPE html><html lang="en"><head>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>' + esc(clean(meta.title) || 'Guide') + '</title>' +
(favicon ? '<link rel="icon" href="favicon.ico">' : '') +
'<meta name="description" content="' + esc(clean(meta.description)) + '">' +
'<style>' + css() +
// logo swap by scheme
'\n@media (prefers-color-scheme: dark){.only-light{display:none!important}.only-dark{display:inline!important}}' +
':root[style*="color-scheme: dark"] .only-light{display:none!important}:root[style*="color-scheme: dark"] .only-dark{display:inline!important}' +
':root[style*="color-scheme: light"] .only-light{display:inline!important}:root[style*="color-scheme: light"] .only-dark{display:none!important}' +
'</style></head><body>' +
'<nav class="nav">' +
'<button class="iconbtn menu-toggle" id="menu-btn" title="Menu">☰</button>' +
brand +
'<div class="spacer"></div>' +
(meta.sourceUrl ? '<div class="navlinks"><a href="' + esc(meta.sourceUrl) + '" target="_blank" rel="noopener">Open the app ↗</a></div>' : '') +
'<div class="icons"><button class="iconbtn" id="theme-btn" title="Toggle theme">◑</button></div>' +
'</nav>' +
'<div class="wrap">' +
'<aside class="sidebar">' + sidebar + '</aside>' +
'<main class="content" id="top">' +
'<div class="hero">' +
(logoLight ? '<img src="img/logo-light.svg" alt="" class="only-light"><img src="img/logo-dark.svg" alt="" class="only-dark" style="display:none">' : '') +
'<div><h1>' + esc(clean(meta.title) || 'Guide') + '</h1></div></div>' +
(clean(meta.description) ? '<p class="lede">' + esc(clean(meta.description)) + '</p>' : '') +
'<div class="meta-row">' +
'<span class="pill">' + guide.steps.length + ' steps</span>' +
(meta.site ? '<span class="pill">' + esc(clean(meta.site)) + '</span>' : '') +
(hasVideo ? '<a class="btn" href="guide.mp4">▶ Watch the video</a>' : '') +
'</div>' +
(hasVideo ? '<div class="videowrap"><video src="guide.mp4" controls preload="metadata" playsinline></video></div>' : '') +
'<div class="callout"><span class="ic">i</span><div>Follow the steps below in order. Each step shows exactly what to click.</div></div>' +
stepsHtml +
'<footer>Generated with Guideo' + (meta.sourceUrl ? ' · <a href="' + esc(meta.sourceUrl) + '" target="_blank" rel="noopener">' + esc(clean(meta.site) || meta.sourceUrl) + '</a>' : '') + '</footer>' +
'</main>' +
'<aside class="toc">' + toc + '</aside>' +
'</div>' +
'<script>' + themeToggleJs() + '</script>' +
'</body></html>';

  files.unshift({ file: 'index.html', data: html, encoding: 'utf-8' });
  // Static hosting niceties for Vercel.
  files.push({ file: 'vercel.json', data: JSON.stringify({ cleanUrls: true, trailingSlash: false }, null, 2), encoding: 'utf-8' });
  return files;
}

/** Write a site file tree to disk (for local preview). Returns the index path. */
export async function writeDocsite(files: SiteFile[], outDir: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  for (const f of files) {
    const abs = path.join(outDir, f.file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  return path.join(outDir, 'index.html');
}
