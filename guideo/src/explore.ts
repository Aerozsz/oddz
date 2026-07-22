import { type Browser, type Page } from 'playwright';
import { launchChromium } from './browser.js';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Guide,
  type Step,
  type AnimationKind,
  DEFAULT_THEME,
} from './types.js';
import {
  overviewCaption,
  actionCaption,
  typedCaption,
  resultCaption,
  panelInfo,
  controlCaption,
  type ElementInfo,
} from './captions.js';
import { buildProviderScript, type WalletConfig } from './wallet.js';
import { buildOverrideScript, type OverrideRule } from './overrides.js';
import { createSigner } from './signer.js';

export interface ExploreOptions {
  url: string;
  outDir: string;
  maxSteps?: number;
  title?: string;
  viewport?: { width: number; height: number };
  headless?: boolean;
  /** Called as steps are captured, for progress UIs. */
  onStep?: (count: number, title: string) => void;
  /** If set, inject a simulated wallet and drive the connect flow. */
  wallet?: WalletConfig;
  /** Multiplier on every step's on-screen time (>1 = slower). Default 1.35. */
  pace?: number;
  /** Record the app's wallet calls + API responses to disk (defaults on with wallet). */
  capture?: boolean;
  /** Assisted connect: open a visible browser and let the user connect, then resume. */
  assist?: boolean;
  /** Force a visible (non-headless) browser. */
  headed?: boolean;
  /** Free-form progress notes for a UI. */
  onNote?: (msg: string) => void;
  /** Replace on-screen numbers with believable test values. */
  overrides?: OverrideRule[];
}

/**
 * Runs in the page. Finds interactive elements, tags them with a stable ref,
 * classifies each, and returns page metadata. Authored as a string (not a
 * function) so the tsx/esbuild transform never injects its `__name` helper
 * into code that gets serialized into the browser context.
 */
const DISCOVER_SRC = String.raw`(function () {
  var vw = window.innerWidth, vh = window.innerHeight;
  function txt(el) {
    return ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function labelFor(el) {
    var id = el.id;
    if (id) { var l = document.querySelector('label[for="' + window.CSS.escape(id) + '"]'); if (l) return txt(l); }
    var wrap = el.closest('label'); if (wrap) return txt(wrap);
    var field = el.closest('.field'); if (field) { var l2 = field.querySelector('label'); if (l2) return txt(l2); }
    return '';
  }
  // Find blocking overlays/modals so their controls can be excluded.
  var modalRoots = [];
  var allForModal = document.querySelectorAll('body *');
  for (var mi = 0; mi < allForModal.length; mi++) {
    var me = allForModal[mi];
    var ms = getComputedStyle(me);
    if ((ms.position === 'fixed' || ms.position === 'absolute') && parseInt(ms.zIndex || '0', 10) >= 20) {
      var mr = me.getBoundingClientRect();
      if (mr.width > vw * 0.4 && mr.height > vh * 0.4 && ms.visibility !== 'hidden' && ms.display !== 'none' && parseFloat(ms.opacity || '1') > 0.6) {
        modalRoots.push(me);
      }
    }
  }
  var inModalOf = function (el) { for (var k = 0; k < modalRoots.length; k++) { if (modalRoots[k].contains(el)) return true; } return false; };

  var nodes = Array.prototype.slice.call(
    document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link]')
  );
  var candidates = [];
  var ref = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();
    var text = txt(el);
    var ariaLabel = el.getAttribute('aria-label') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var href = el.getAttribute('href') || '';
    var name = el.getAttribute('name') || '';
    var target = el.getAttribute('target') || '';
    var label = labelFor(el);
    var cls = typeof el.className === 'string' ? el.className : '';
    var lc = (text + ' ' + ariaLabel + ' ' + placeholder + ' ' + name + ' ' + cls).toLowerCase();
    var kind = 'link';
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) kind = 'checkbox';
    else if (el.classList.contains('check')) kind = 'checkbox';
    else if (tag === 'select') kind = 'select';
    else if (tag === 'textarea') kind = 'text';
    else if (tag === 'input' && (type === 'search' || /search|filter|query/.test(lc))) kind = 'search';
    else if (tag === 'input' && ['text', 'email', 'tel', 'number', 'password', 'url', ''].indexOf(type) >= 0) kind = 'text';
    else if (tag === 'button' || type === 'submit' || type === 'button' || role === 'button') {
      if (/sign up|create account|save|submit|continue|finish|register/.test(lc)) kind = 'submit';
      else if (/get started|start free|try|join|create/.test(lc)) kind = 'cta';
      else kind = 'button';
    } else if (tag === 'a' || role === 'link') {
      var inNav = !!el.closest('nav, header');
      if (/btn|button|primary|cta/.test(cls) || /get started|sign up|start free|create account/.test(lc)) kind = 'cta';
      else if (inNav) kind = 'nav';
      else kind = 'link';
    }
    el.setAttribute('data-guideo-ref', String(ref));
    candidates.push({
      ref: ref, tag: tag, type: type, role: role, text: text, ariaLabel: ariaLabel,
      placeholder: placeholder, label: label, href: href, name: name, target: target, kind: kind,
      inModal: inModalOf(el),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }
    });
    ref++;
  }
  function firstText(sel) { var e = document.querySelector(sel); return e ? txt(e) : ''; }
  var heading = firstText('h1') || firstText('h2');
  var p = document.querySelector('main p, .hero p, section p, p');
  var intro = p ? (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) : '';
  var sampleQuery = '';
  var item = document.querySelector('.row .title, li, [class*=item]');
  if (item) {
    var words = (item.textContent || '').replace(/\s+/g, ' ').trim().split(' ').filter(function (w) { return w.length > 3; });
    if (words.length) sampleQuery = words[words.length - 1];
  }
  var title = document.title || '';
  var active = document.querySelector('nav a.active, nav .active');
  var pageName = active ? txt(active)
    : heading ? heading.split(/[—-]/)[0].trim().split(' ').slice(0, 3).join(' ')
    : title.split(/[—|]/)[0].trim();
  return { page: { title: title, heading: heading, intro: intro, pageName: pageName, sampleQuery: sampleQuery }, candidates: candidates, url: location.href, vw: vw, vh: vh };
})()`;

/** Tag the icon "tabs" of a persistent right-side action panel. */
const TAG_PANEL_TABS_SRC = String.raw`(function () {
  var vw = window.innerWidth, vh = window.innerHeight;
  document.querySelectorAll('[data-guideo-tab]').forEach(function (e) { e.removeAttribute('data-guideo-tab'); });
  var nodes = document.querySelectorAll('button, [role=button], a');
  var tabs = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || r.width > 96 || r.height > 96) continue;
    if (r.left < vw * 0.60) continue;   // right side only
    if (r.top > vh * 0.5) continue;     // upper area
    var txt = ((el.innerText || el.textContent || '') + '').trim();
    if (txt.length > 3) continue;       // icon-only
    if (!el.querySelector('svg, img, i')) continue;
    tabs.push({ el: el, x: r.left, y: r.top });
  }
  if (!tabs.length) return { count: 0 };
  tabs.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
  var y0 = tabs[0].y;
  var row = tabs.filter(function (t) { return Math.abs(t.y - y0) < 26; });
  row.sort(function (a, b) { return a.x - b.x; });
  for (var j = 0; j < row.length; j++) row[j].el.setAttribute('data-guideo-tab', String(j));
  return { count: row.length };
})()`;

/** Read the current panel's heading, bounding box, and key controls. Scoped to
 *  the actual panel container (the ancestor of the tabs that also holds the
 *  form) so background page content can't bleed into the heading. */
const READ_PANEL_SRC = String.raw`(function () {
  var vw = window.innerWidth, vh = window.innerHeight;
  document.querySelectorAll('[data-guideo-ctl]').forEach(function (e) { e.removeAttribute('data-guideo-ctl'); });

  var tabEls = document.querySelectorAll('[data-guideo-tab]');
  var panel = null;
  if (tabEls.length) {
    panel = tabEls[0];
    while (panel && panel.parentElement && panel.tagName !== 'BODY') {
      var okTabs = true;
      for (var t = 0; t < tabEls.length; t++) { if (!panel.contains(tabEls[t])) { okTabs = false; break; } }
      var hasForm = !!panel.querySelector('input');
      if (!hasForm) {
        var bb = panel.querySelectorAll('button, [role=button]');
        for (var q = 0; q < bb.length; q++) { if (bb[q].getBoundingClientRect().width > vw * 0.15) { hasForm = true; break; } }
      }
      if (okTabs && hasForm) break;
      panel = panel.parentElement;
    }
  }
  var scope = panel && panel.tagName !== 'BODY' ? panel : document.body;
  var pr = scope.getBoundingClientRect();

  var inScope = Array.prototype.slice.call(scope.querySelectorAll('*'));
  var heading = '', best = 0;
  for (var i = 0; i < inScope.length; i++) {
    var el = inScope[i], r = el.getBoundingClientRect();
    var own = Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join('').trim();
    if (!own || own.length > 28) continue;
    var fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (fs > best && r.top < pr.top + pr.height * 0.5) { best = fs; heading = own; }
  }

  var ctls = [], ref = 0;
  var tag = function (el, kind) {
    if (!el) return;
    el.setAttribute('data-guideo-ctl', String(ref));
    var r = el.getBoundingClientRect();
    ctls.push({ ref: ref, kind: kind, x: r.left, y: r.top, w: r.width, h: r.height });
    ref++;
  };
  tag(inScope.filter(function (e) { return e.tagName === 'INPUT' || e.tagName === 'TEXTAREA'; })[0], 'amount');
  var pct = inScope.filter(function (e) { return /^(max|25%|50%|75%|100%)$/i.test(((e.innerText || '') + '').trim()); });
  if (pct.length) tag(pct[0].parentElement || pct[0], 'percent');
  var btns = inScope.filter(function (e) { return e.tagName === 'BUTTON' || e.getAttribute('role') === 'button'; });
  var cta = null, sc = -1;
  for (var b = 0; b < btns.length; b++) {
    var rb = btns[b].getBoundingClientRect();
    if (rb.width > vw * 0.15) { var s = rb.width * rb.top; if (s > sc) { sc = s; cta = btns[b]; } }
  }
  tag(cta, 'cta');

  return { heading: heading, controls: ctls, panel: { x: pr.left, y: pr.top, w: pr.width, h: pr.height } };
})()`;

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    s = s.replace(/\/index\.html?$/i, '');
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

function sampleValue(el: ElementInfo): string {
  const l = (el.label + ' ' + el.placeholder + ' ' + el.name + ' ' + el.type).toLowerCase();
  if (/email/.test(l)) return 'alex@company.com';
  if (/name/.test(l)) return 'Alex Rivera';
  if (/phone|tel/.test(l)) return '(555) 123-4567';
  if (/company|team|org/.test(l)) return 'Acme Co';
  return el.placeholder || 'Sample text';
}

const DESTRUCTIVE = /log ?out|sign ?out|delete|remove|cancel|unsubscribe|deactivate/i;
/** Low-value destinations a beginner guide should skip. */
const BORING = /faq|docs|documentation|blog|support|help ?center|careers?|terms|privacy|legal|cookie|about|contact|whitepaper|github|discord|twitter|telegram|medium/i;

export async function explore(opts: ExploreOptions): Promise<Guide> {
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  // Dapps have a lot to cover (the action panel + pages), so give them headroom.
  const maxSteps = Math.max(opts.maxSteps ?? 14, opts.wallet || opts.assist ? 28 : 0);
  const pace = opts.pace && opts.pace > 0 ? opts.pace : 1.35;
  // On real dapps the generic search/checkbox/form demos produce nonsense
  // (e.g. ticking a Terms checkbox, opening the account modal). The panel walk
  // and page overviews carry the tour instead.
  const isDapp = !!opts.wallet;
  const shotsDir = path.join(opts.outDir, 'screenshots');
  const videoDir = path.join(opts.outDir, 'video');
  await mkdir(shotsDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });

  const headless = opts.assist || opts.headed ? false : opts.headless ?? true;
  const browser: Browser = await launchChromium({ headless });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: viewport },
  });
  const capture = opts.capture ?? !!opts.wallet;
  const walletLog: any[] = [];
  const netLog: any[] = [];
  if (capture) {
    // Bridge that the injected wallet calls on every request; persists across
    // navigations, so we record every eth_call the app makes.
    await context.exposeBinding('__guideoLog', (_src, entry: any) => {
      if (walletLog.length < 4000) walletLog.push(entry);
    });
  }
  if (opts.wallet) {
    // A real throwaway key so signatures verify (SIWE / Terms gates).
    const signer = createSigner(opts.wallet.privateKey);
    opts.wallet.address = signer.address;
    opts.wallet.privateKey = signer.privateKey;
    await context.exposeBinding('__guideoSign', (_src, req: any) => signer.sign(req));
    await context.addInitScript({ content: buildProviderScript(opts.wallet) });
  }
  if (opts.overrides && opts.overrides.length) {
    await context.addInitScript({ content: buildOverrideScript(opts.overrides) });
  }
  const page: Page = await context.newPage();

  if (capture) {
    // Record the app's own data responses (API / GraphQL / subgraph / RPC).
    page.on('response', async (resp) => {
      try {
        const req = resp.request();
        if (!['xhr', 'fetch'].includes(req.resourceType())) return;
        const ct = resp.headers()['content-type'] || '';
        let body = '';
        if (/json|text|graphql|javascript/.test(ct)) {
          const buf = await resp.body().catch(() => null);
          if (buf) body = buf.toString('utf8').slice(0, 6000);
        }
        netLog.push({
          url: req.url(),
          method: req.method(),
          status: resp.status(),
          contentType: ct,
          postData: (req.postData() || '').slice(0, 3000),
          body,
        });
        if (netLog.length > 1200) netLog.shift();
      } catch { /* ignore unreadable responses */ }
    });
  }

  const steps: Step[] = [];
  const visited = new Set<string>();
  const demoed = new Set<string>();
  const clickedRefs = new Set<string>();
  let shotIndex = 0;

  const origin = (() => {
    try {
      return new URL(opts.url).origin;
    } catch {
      return '';
    }
  })();

  async function settle() {
    try {
      await page.waitForLoadState('networkidle', { timeout: 4000 });
    } catch {
      /* fine — some pages never idle */
    }
    await page.waitForTimeout(350);
  }

  async function shoot(): Promise<string> {
    const rel = path.join('screenshots', `step-${String(shotIndex).padStart(2, '0')}.png`);
    await page.screenshot({ path: path.join(opts.outDir, rel) });
    shotIndex++;
    return rel;
  }

  /** Save the connected page's HTML so override rules can be tuned to it. */
  async function dumpDom(tag: string) {
    if (!capture) return;
    try {
      const html = await page.content();
      await mkdir(path.join(opts.outDir, 'dom'), { recursive: true });
      await writeFile(path.join(opts.outDir, 'dom', `${tag}.html`), html);
    } catch { /* ignore */ }
  }

  /** Move the real cursor and compute normalized cursor/highlight for a locator. */
  async function focusLocator(loc: import('playwright').Locator) {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    } catch {
      /* ignore */
    }
    const box = await loc.boundingBox();
    const vp = page.viewportSize() ?? viewport;
    if (!box) return { cursor: null, highlight: null };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    const pad = 8;
    return {
      cursor: { x: clamp01(cx / vp.width), y: clamp01(cy / vp.height), click: true },
      highlight: {
        x: clamp01((box.x - pad) / vp.width),
        y: clamp01((box.y - pad) / vp.height),
        w: clamp01((box.width + pad * 2) / vp.width),
        h: clamp01((box.height + pad * 2) / vp.height),
      },
    };
  }

  /** Focus a tagged candidate by its discovery ref. */
  function focusRef(ref: number) {
    return focusLocator(page.locator(`[data-guideo-ref="${ref}"]`).first());
  }

  function addStep(
    partial: Omit<Step, 'id' | 'image'> & { image: string }
  ): void {
    const durationMs = Math.round((partial.durationMs || 3800) * pace);
    // Put the caption at the top when what we're highlighting sits low, so the
    // caption never covers it (e.g. a panel's confirm button at the bottom).
    const focusY = partial.highlight
      ? partial.highlight.y + partial.highlight.h / 2
      : partial.cursor
      ? partial.cursor.y
      : null;
    const captionPos: 'top' | 'bottom' = focusY != null && focusY > 0.6 ? 'top' : 'bottom';
    steps.push({ id: `s${steps.length}`, ...partial, durationMs, captionPos });
    opts.onStep?.(steps.length, partial.title);
  }

  async function overviewStep(pinfo: any, isFirst: boolean) {
    const image = await shoot();
    addStep({
      image,
      title: pinfo.pageName || 'Overview',
      caption: overviewCaption(pinfo, isFirst),
      durationMs: isFirst ? 4600 : 4000,
      animation: (isFirst ? 'kenburns-in' : 'fade') as AnimationKind,
      cursor: null,
      highlight: null,
      action: { type: isFirst ? 'observe' : 'navigate', target: pinfo.url },
    });
    if (walletConnected) await dumpDom(`page-${shotIndex}`);
  }

  let walletConnected = false;
  let panelWalked = false;

  /** Walk the app's persistent action panel: click each tab, highlight its key
   *  controls, and explain what each does. This is where dapp users spend most
   *  of their time (swap / deposit / redeem / stake / bridge). */
  async function walkPanel(): Promise<boolean> {
    let res: any;
    try { res = await page.evaluate(TAG_PANEL_TABS_SRC); } catch { return false; }
    const count = res && res.count ? res.count : 0;
    if (!count) return false;
    opts.onNote?.(`Found the action panel (${count} tabs) — explaining each one.`);
    const vp = page.viewportSize() ?? viewport;
    let added = false;
    for (let i = 0; i < count && steps.length < maxSteps; i++) {
      try { await page.locator(`[data-guideo-tab="${i}"]`).first().click({ timeout: 2500 }); } catch { /* ignore */ }
      await page.waitForTimeout(700);
      let info: any;
      try { info = await page.evaluate(READ_PANEL_SRC); } catch { continue; }
      const pi = panelInfo(info.heading || '');
      const p = info.panel;
      const hl = p && p.w > 0 && p.h > 0
        ? { x: clamp01(p.x / vp.width), y: clamp01(p.y / vp.height), w: clamp01(p.w / vp.width), h: clamp01(p.h / vp.height) }
        : null;
      addStep({
        image: await shoot(),
        title: pi.title,
        caption: pi.caption,
        durationMs: 5000, animation: 'fade', cursor: null, highlight: hl,
        action: { type: 'observe', target: info.heading },
      });
      added = true;
      for (const c of (info.controls || []).slice(0, 4)) {
        if (steps.length >= maxSteps) break;
        const f = await focusLocator(page.locator(`[data-guideo-ctl="${c.ref}"]`).first());
        if (!f.cursor) continue;
        addStep({
          image: await shoot(),
          title: pi.title,
          caption: controlCaption(c.kind, info.heading || ''),
          durationMs: 3800, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
          action: { type: 'observe' },
        });
      }
    }
    return added;
  }

  function scoreConnect(c: any): number {
    const t = (c.text || '').toLowerCase().trim();
    if (/connect wallet/.test(t)) return 4;
    if (/^connect$/.test(t)) return 3;
    if (/launch app|open app|enter app/.test(t)) return 2;
    if (/sign in|log in/.test(t)) return 1;
    return 0;
  }

  async function findWalletOption(name: string) {
    const attempts = [
      page.getByRole('button', { name, exact: false }),
      page.getByText(name, { exact: false }),
      page.getByRole('button', { name: /metamask/i }),
      page.getByText(/metamask/i),
      page.getByText(/injected|browser wallet|detected/i),
    ];
    for (const loc of attempts) {
      try {
        const first = loc.first();
        if (await first.isVisible({ timeout: 600 })) return first;
      } catch { /* try next */ }
    }
    return null;
  }

  /** Drive a dapp's "Connect Wallet" flow using the injected demo wallet. */
  async function connectWallet(): Promise<boolean> {
    if (!opts.wallet || walletConnected) return false;
    const info: any = await page.evaluate(DISCOVER_SRC);
    const trigger = (info.candidates as any[])
      .filter((c) => ['button', 'cta', 'nav', 'link'].includes(c.kind))
      .filter((c) => scoreConnect(c) > 0)
      .sort((a, b) => scoreConnect(b) - scoreConnect(a))[0];
    if (!trigger) return false;

    const f = await focusRef(trigger.ref);
    addStep({
      image: await shoot(),
      title: 'Connect wallet',
      caption: `Click “${trigger.text || 'Connect Wallet'}” to link your crypto wallet — this is how the app knows it’s you.`,
      durationMs: 4400, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
      action: { type: 'click', target: trigger.text },
    });
    try {
      await page.locator(`[data-guideo-ref="${trigger.ref}"]`).first().click({ timeout: 3000 });
    } catch { /* ignore */ }
    await page.waitForTimeout(900);
    await settle();

    const picker = await findWalletOption(opts.wallet.name);
    if (picker) {
      const f2 = await focusLocator(picker);
      addStep({
        image: await shoot(),
        title: 'Choose wallet',
        caption: 'Pick your wallet from the list. Here we use a demo wallet so you can preview the whole app safely.',
        durationMs: 4400, animation: 'fade', cursor: f2.cursor, highlight: f2.highlight,
        action: { type: 'click', target: opts.wallet.name },
      });
      try { await picker.click({ timeout: 3000 }); } catch { /* ignore */ }
      await page.waitForTimeout(1300);
      await settle();
    }

    walletConnected = true;
    await page.evaluate(DISCOVER_SRC); // re-tag the now-unlocked page
    addStep({
      image: await shoot(),
      title: 'Connected',
      caption: 'You’re connected! The app now shows your dashboard — balances, positions and yields tied to your wallet.',
      durationMs: 5400, animation: 'kenburns-in', cursor: null, highlight: null,
      action: { type: 'observe' },
    });
    await dumpDom('connected');
    return true;
  }

  /** True when no large, high-z-index overlay (wallet/terms/signature modal) covers the page. */
  async function noBlockingModal(): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const els = document.querySelectorAll('body *');
        for (const el of els) {
          const s = getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'absolute') && parseInt(s.zIndex || '0', 10) >= 20) {
            const r = el.getBoundingClientRect();
            if (r.width > vw * 0.45 && r.height > vh * 0.45 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.6) {
              const t = ((el as HTMLElement).innerText || '').toLowerCase();
              if (/terms|sign|accept|signature|connect wallet|invalid/.test(t)) return false;
            }
          }
        }
        return true;
      });
    } catch {
      return true;
    }
  }

  /** Assisted connect: show a banner, wait for the human to connect, then resume. */
  async function waitForUserConnect(timeoutMs = 180000): Promise<boolean> {
    opts.onNote?.('A browser window is open. Click “Connect”, choose “Guideo Demo Wallet”, then accept any Terms / signature prompt. I’ll take over once you’re in.');
    try {
      await page.evaluate(() => {
        if (document.getElementById('guideo-banner')) return;
        const b = document.createElement('div');
        b.id = 'guideo-banner';
        b.textContent = '⬤ Guideo: connect “Guideo Demo Wallet”, then accept any Terms / signature prompt — I’ll take over once you’re in.';
        const s = b.style;
        s.position = 'fixed'; s.left = '0'; s.right = '0'; s.top = '0'; s.zIndex = '2147483647';
        s.background = 'linear-gradient(90deg,#6d5efc,#33d6a6)'; s.color = '#fff';
        s.font = '600 15px system-ui,sans-serif'; s.padding = '12px 16px'; s.textAlign = 'center';
        document.body.appendChild(b);
      });
    } catch { /* ignore */ }

    // 1) Wait until the user actually connects OUR wallet. Only our provider's
    //    flag counts — never text on the page (dapps show truncated contract
    //    addresses on load, which used to trip a false "connected").
    const connectDeadline = Date.now() + timeoutMs;
    let connected = false;
    while (Date.now() < connectDeadline) {
      try {
        connected = await page.evaluate(
          () => !!(window as any).__guideoConnected ||
            !!((window as any).ethereum && (window as any).ethereum._guideo && (window as any).ethereum.selectedAddress)
        );
      } catch { /* page mid-navigation */ }
      if (connected) break;
      await page.waitForTimeout(1000);
    }
    if (!connected) {
      opts.onNote?.('Didn’t detect a wallet connection in time; continuing with the public pages.');
      walletConnected = true;
      return false;
    }

    // 2) Let the user accept Terms / sign. Proceed when a signature has been
    //    made and no modal covers the page — or, if the app needs no signature,
    //    once the page has stayed modal-free for a while.
    opts.onNote?.('Connected — accept any Terms / signature prompt in the wallet; I’ll continue right after.');
    const signDeadline = Date.now() + 150000;
    let clearStreak = 0;
    while (Date.now() < signDeadline) {
      let signed = 0;
      try { signed = await page.evaluate(() => (window as any).__guideoSignCount || 0); } catch {}
      const clear = await noBlockingModal();
      if (signed >= 1 && clear) break;
      clearStreak = clear ? clearStreak + 1 : 0;
      if (signed === 0 && clearStreak >= 12) break; // ~14s modal-free & no sign → none needed
      await page.waitForTimeout(1200);
    }

    try { await page.evaluate(() => { const b = document.getElementById('guideo-banner'); if (b) b.remove(); }); } catch {}
    await settle();
    walletConnected = true;
    await page.evaluate(DISCOVER_SRC);
    addStep({
      image: await shoot(),
      title: 'Connected',
      caption: 'You’re connected! The app now shows your dashboard — balances, positions and yields tied to your wallet.',
      durationMs: 5400, animation: 'kenburns-in', cursor: null, highlight: null,
      action: { type: 'observe' },
    });
    await dumpDom('connected');
    opts.onNote?.('All set — continuing the tour automatically.');
    return true;
  }

  // ---- Start ----
  await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
  await settle();
  {
    const info: any = await page.evaluate(DISCOVER_SRC);
    visited.add(normUrl(info.url));
    await overviewStep(info.page, true);
  }

  // ---- Main loop ----
  while (steps.length < maxSteps) {
    const info: any = await page.evaluate(DISCOVER_SRC);
    const curUrl = normUrl(info.url);
    const cands: (ElementInfo & { ref: number; href: string; target: string; rect: any; inModal: boolean })[] =
      info.candidates;
    const key = (feat: string) => `${curUrl}#${feat}`;

    // 0) If this is a web3 app, connect the wallet before anything else.
    if (opts.wallet && !walletConnected) {
      const ok = opts.assist ? await waitForUserConnect() : await connectWallet();
      if (ok) continue;
    }

    // 0b) Walk the main action panel (swap/deposit/redeem/stake/bridge) once.
    if (walletConnected && !panelWalked) {
      panelWalked = true;
      if (await walkPanel()) continue;
    }

    // 1) Demonstrate a search box on this page.
    const search = isDapp ? undefined : cands.find((c) => c.kind === 'search' && !c.inModal);
    if (search && !demoed.has(key('search'))) {
      demoed.add(key('search'));
      const q = info.page.sampleQuery || 'budget';
      const f = await focusRef(search.ref);
      addStep({
        image: await shoot(),
        title: 'Search',
        caption: actionCaption(search),
        durationMs: 3800, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
        action: { type: 'click', target: search.text || 'search' },
      });
      await page.locator(`[data-guideo-ref="${search.ref}"]`).first().fill(q);
      await page.waitForTimeout(500);
      const f2 = await focusRef(search.ref);
      addStep({
        image: await shoot(),
        title: 'Live filtering',
        caption: typedCaption(search, q),
        durationMs: 4000, animation: 'none', cursor: f2.cursor, highlight: null,
        action: { type: 'type', target: search.text || 'search', value: q },
      });
      continue;
    }

    // 2) Demonstrate ticking a checkbox / toggle.
    const check = isDapp ? undefined : cands.find((c) => c.kind === 'checkbox' && !c.inModal);
    if (check && !demoed.has(key('checkbox'))) {
      demoed.add(key('checkbox'));
      const f = await focusRef(check.ref);
      addStep({
        image: await shoot(),
        title: 'Mark as done',
        caption: actionCaption(check),
        durationMs: 3600, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
        action: { type: 'click', target: 'checkbox' },
      });
      try {
        await page.locator(`[data-guideo-ref="${check.ref}"]`).first().click({ timeout: 2000 });
      } catch { /* ignore */ }
      await page.waitForTimeout(400);
      addStep({
        image: await shoot(),
        title: 'Done',
        caption: resultCaption(check),
        durationMs: 3200, animation: 'none', cursor: null, highlight: null,
        action: { type: 'observe' },
      });
      continue;
    }

    // 3) Demonstrate filling a form (text inputs + selects, then submit).
    const fields = isDapp ? [] : cands.filter((c) => (c.kind === 'text' || c.kind === 'select') && !c.inModal);
    const submit = isDapp ? undefined : cands.find((c) => c.kind === 'submit' && !c.inModal);
    if (fields.length >= 1 && submit && !demoed.has(key('form')) && steps.length + fields.length + 2 <= maxSteps + 3) {
      demoed.add(key('form'));
      for (const field of fields) {
        const val = field.kind === 'select' ? '' : sampleValue(field);
        const loc = page.locator(`[data-guideo-ref="${field.ref}"]`).first();
        const f = await focusRef(field.ref);
        if (field.kind === 'select') {
          try { await loc.selectOption({ index: 1 }); } catch { /* ignore */ }
        } else {
          try { await loc.fill(val); } catch { /* ignore */ }
        }
        await page.waitForTimeout(250);
        addStep({
          image: await shoot(),
          title: field.label || 'Fill in',
          caption: actionCaption(field),
          durationMs: 3500, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
          action: { type: field.kind === 'select' ? 'click' : 'type', target: field.label, value: val },
        });
      }
      const fs = await focusRef(submit.ref);
      addStep({
        image: await shoot(),
        title: 'Submit',
        caption: actionCaption(submit),
        durationMs: 3600, animation: 'fade', cursor: fs.cursor, highlight: fs.highlight,
        action: { type: 'click', target: submit.text },
      });
      try {
        await page.locator(`[data-guideo-ref="${submit.ref}"]`).first().click({ timeout: 2000 });
      } catch { /* ignore */ }
      await page.waitForTimeout(500);
      addStep({
        image: await shoot(),
        title: 'All set',
        caption: resultCaption(submit),
        durationMs: 3400, animation: 'kenburns-out', cursor: null, highlight: null,
        action: { type: 'observe' },
      });
      continue;
    }

    // 4) Navigate to an unvisited page.
    const nav = pickNavigation(cands, curUrl, origin, visited, clickedRefs);
    if (nav) {
      clickedRefs.add(`${curUrl}:${nav.ref}`);
      const f = await focusRef(nav.ref);
      addStep({
        image: await shoot(),
        title: nav.text || 'Navigate',
        caption: actionCaption(nav),
        durationMs: 3600, animation: 'fade', cursor: f.cursor, highlight: f.highlight,
        action: { type: 'click', target: nav.text, value: nav.href },
      });
      const before = normUrl(page.url());
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}),
          page.locator(`[data-guideo-ref="${nav.ref}"]`).first().click({ timeout: 3000 }),
        ]);
      } catch { /* ignore */ }
      await settle();
      const after = normUrl(page.url());
      if (after !== before && !visited.has(after)) {
        visited.add(after);
        const info2: any = await page.evaluate(DISCOVER_SRC);
        await overviewStep(info2.page, false);
      }
      continue;
    }

    break; // nothing left to do
  }

  // ---- Finalize ----
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();
  if (videoPath) {
    try {
      await copyFile(videoPath, path.join(opts.outDir, 'recording.webm'));
    } catch { /* ignore */ }
  }

  if (capture) {
    // Diagnostics for tailoring test data to a specific dapp. Send these two
    // files to have exact numbers crafted per field.
    const calls = { count: walletLog.length, calls: dedupeCalls(walletLog) };
    await writeFile(path.join(opts.outDir, 'wallet-calls.json'), JSON.stringify(calls, null, 2));
    await writeFile(path.join(opts.outDir, 'network.json'), JSON.stringify(netLog, null, 2));
    opts.onStep?.(steps.length, `capture: ${walletLog.length} wallet calls, ${netLog.length} responses`);
  }

  const guide: Guide = {
    version: 1,
    meta: {
      title: opts.title || `How to use ${new URL(opts.url).hostname}`,
      description: 'A beginner-friendly walkthrough generated by Guideo.',
      site: safeHost(opts.url),
      sourceUrl: opts.url,
      createdAt: new Date().toISOString(),
      viewport,
    },
    theme: { ...DEFAULT_THEME },
    steps,
  };
  await writeFile(path.join(opts.outDir, 'guide.json'), JSON.stringify(guide, null, 2));
  return guide;
}

function pickNavigation(
  cands: any[],
  curUrl: string,
  origin: string,
  visited: Set<string>,
  clickedRefs: Set<string>
) {
  const score: Record<string, number> = { nav: 3, cta: 2, link: 1, button: 0.4 };
  let best: any = null;
  let bestScore = -1;
  for (const c of cands) {
    if (!['nav', 'cta', 'link', 'button'].includes(c.kind)) continue;
    if (clickedRefs.has(`${curUrl}:${c.ref}`)) continue;
    if (DESTRUCTIVE.test(c.text)) continue;
    if (BORING.test(c.text) || BORING.test(c.href || '')) continue;
    if (c.inModal) continue; // never navigate via modal/overlay content
    // Skip the connected-account pill and its menu (opens the wallet modal).
    if (/0x[a-fA-F0-9]{3,}(?:\.{2,3}|…)/.test(c.text) || /disconnect|copy address/i.test(c.text)) continue;
    let dest = '';
    if (c.href) {
      if (/^(mailto:|tel:|javascript:|#)/.test(c.href)) continue;
      try {
        dest = normUrl(new URL(c.href, curUrl).toString());
      } catch {
        continue;
      }
      if (origin && !dest.startsWith(origin)) continue; // stay on-site
      if (c.target === '_blank') continue;
      if (dest === curUrl) continue; // same page (e.g. the logo/brand link)
      if (visited.has(dest)) continue;
    } else if (c.kind !== 'cta' && c.kind !== 'button') {
      continue;
    }
    const s = (score[c.kind] ?? 0) + (dest ? 1 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** Collapse repeated wallet calls; for eth_call, key by target + 4-byte selector
 *  so the distinct contract reads (and their call counts) are easy to eyeball. */
function dedupeCalls(log: any[]): any[] {
  const map = new Map<string, any>();
  for (const e of log) {
    const method = e.method;
    let key = method;
    let extra: any = {};
    if (method === 'eth_call' && Array.isArray(e.params) && e.params[0]) {
      const to = e.params[0].to || '';
      const data = e.params[0].data || e.params[0].input || '';
      const selector = typeof data === 'string' ? data.slice(0, 10) : '';
      key = `${method}:${to}:${selector}`;
      extra = { to, selector, sampleData: data };
    }
    const cur = map.get(key);
    if (cur) cur.count++;
    else map.set(key, { method, ...extra, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}
