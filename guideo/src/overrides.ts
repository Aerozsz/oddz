/**
 * On-screen number overrides. A dapp connected with the demo wallet shows $0
 * everywhere (the demo address holds nothing), so to make a guide look like a
 * funded, active account we replace the rendered values with believable test
 * numbers. This runs in the page as an init-script with a MutationObserver, so
 * it keeps re-applying as the SPA renders and navigates.
 *
 * Rules are intentionally simple and data-source-agnostic (they operate on the
 * final rendered text), and live in JSON so they can be tuned without code
 * changes once a specific app's DOM is known.
 */

export interface OverrideRule {
  /** Anchor on an element whose own text equals/startsWith this label, then
   *  replace the first number found nearby (per `scope`). */
  label?: string;
  /** Any text node containing this substring → replace its first number. */
  contains?: string;
  /** Exact visible token to replace wherever it appears. */
  find?: string;
  /** Where the number sits relative to a `label`. */
  scope?: 'auto' | 'self' | 'next' | 'row';
  /** Replacement text (include %, $, commas as you want them shown). */
  value: string;
  /** Apply to every match rather than just the first. */
  all?: boolean;
}

/** Build the init-script (a string, so esbuild never rewrites it). */
export function buildOverrideScript(rules: OverrideRule[]): string {
  return `(() => {
  const RULES = ${JSON.stringify(rules)};
  const numRe = /[0-9][0-9,]*\\.?[0-9]*/;
  const textNodes = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const out = []; let n; while ((n = w.nextNode())) out.push(n); return out;
  };
  const setNum = (t, value) => {
    if (!t || !numRe.test(t.nodeValue)) return false;
    // Function replacement so $ / $& in a value are never treated as specials;
    // values are bare numbers, so replacing the number with itself is a no-op
    // (idempotent) and existing $ / % prefixes and suffixes are preserved.
    const nv = t.nodeValue.replace(numRe, () => value);
    if (nv === t.nodeValue) return false; // already applied — avoids observer churn
    t.nodeValue = nv; return true;
  };
  const ownText = (el) => Array.prototype.filter.call(el.childNodes, (n) => n.nodeType === 3)
    .map((n) => n.nodeValue).join('').trim();

  const applyFind = (r) => {
    let done = 0;
    for (const t of textNodes(document.body)) {
      if (t.nodeValue.indexOf(r.find) === -1) continue;
      const nv = t.nodeValue.split(r.find).join(r.value);
      if (nv !== t.nodeValue) { t.nodeValue = nv; done++; if (!r.all) break; }
    }
    return done;
  };
  const applyContains = (r) => {
    let done = 0;
    const key = r.contains.toLowerCase();
    for (const t of textNodes(document.body)) {
      if (t.nodeValue.toLowerCase().indexOf(key) === -1) continue;
      if (setNum(t, r.value)) { done++; if (!r.all) break; }
    }
    return done;
  };
  const labelEls = (label) => {
    const low = label.toLowerCase(); const res = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      const own = ownText(el).toLowerCase();
      if (own === low || (own.length && own.startsWith(low) && own.length < low.length + 3)) res.push(el);
    }
    return res;
  };
  const valueNodeFor = (labelEl, scope) => {
    const skip = new Set(textNodes(labelEl));
    const cands = [];
    if (scope === 'self' || scope === 'auto') cands.push(labelEl);
    let sib = labelEl.nextElementSibling, hop = 0;
    while (sib && hop < 4) { cands.push(sib); sib = sib.nextElementSibling; hop++; }
    if ((scope === 'row' || scope === 'auto') && labelEl.parentElement) cands.push(labelEl.parentElement);
    for (const c of cands) {
      for (const t of textNodes(c)) {
        if (scope !== 'self' && skip.has(t)) continue;
        if (numRe.test(t.nodeValue)) return t;
      }
    }
    return null;
  };
  const applyLabel = (r) => {
    let done = 0;
    for (const el of labelEls(r.label)) {
      const t = valueNodeFor(el, r.scope || 'auto');
      if (setNum(t, r.value)) { done++; if (!r.all) break; }
    }
    return done;
  };

  const applyAll = () => {
    if (!document.body) return;
    for (const r of RULES) {
      try { r.find != null ? applyFind(r) : r.contains != null ? applyContains(r) : applyLabel(r); }
      catch (e) {}
    }
  };
  let scheduled = false;
  const schedule = () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; applyAll(); }, 250); };
  const start = () => {
    if (!document.body) return setTimeout(start, 100);
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
    applyAll();
  };
  start();
})();`;
}

/**
 * Believable starter numbers for makina.finance (~$52k active account).
 * A first pass anchored on labels visible in the UI — to be tightened once a
 * real connected DOM is captured (Guideo writes dom/*.html for exactly this).
 */
export const MAKINA_OVERRIDES: OverrideRule[] = [
  { label: 'Portfolio', scope: 'auto', value: '52,480' },
  { label: 'Season 0', scope: 'row', value: '1,204.52' },
  { label: 'Season 1', scope: 'row', value: '4,865.61' },
  { label: 'Season 2', scope: 'row', value: '6,142.33' },
  { label: 'Season 3', scope: 'row', value: '3,908.09' },
  { contains: 'usdshfmk avail', value: '51,204.88' },
  { contains: 'usdc avail', value: '8,650.42' },
];

const PRESETS: Record<string, OverrideRule[]> = {
  'makina.finance': MAKINA_OVERRIDES,
};

/** Pick a built-in override preset by hostname, if one exists. */
export function presetForHost(url: string): OverrideRule[] | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const key of Object.keys(PRESETS)) if (host.endsWith(key)) return PRESETS[key];
  } catch { /* ignore */ }
  return undefined;
}
