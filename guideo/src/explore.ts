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
  type ElementInfo,
} from './captions.js';
import { buildProviderScript, type WalletConfig } from './wallet.js';

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

export async function explore(opts: ExploreOptions): Promise<Guide> {
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const maxSteps = opts.maxSteps ?? 14;
  const pace = opts.pace && opts.pace > 0 ? opts.pace : 1.35;
  const shotsDir = path.join(opts.outDir, 'screenshots');
  const videoDir = path.join(opts.outDir, 'video');
  await mkdir(shotsDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });

  const browser: Browser = await launchChromium({ headless: opts.headless ?? true });
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
    await context.addInitScript({ content: buildProviderScript(opts.wallet) });
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
    steps.push({ id: `s${steps.length}`, ...partial, durationMs });
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
  }

  let walletConnected = false;

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
    const cands: (ElementInfo & { ref: number; href: string; target: string; rect: any })[] =
      info.candidates;
    const key = (feat: string) => `${curUrl}#${feat}`;

    // 0) If this is a web3 app, connect the wallet before anything else.
    if (opts.wallet && !walletConnected) {
      if (await connectWallet()) continue;
    }

    // 1) Demonstrate a search box on this page.
    const search = cands.find((c) => c.kind === 'search');
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
    const check = cands.find((c) => c.kind === 'checkbox');
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
    const fields = cands.filter((c) => c.kind === 'text' || c.kind === 'select');
    const submit = cands.find((c) => c.kind === 'submit');
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
