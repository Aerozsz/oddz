import { launchChromium } from '../src/browser.js';
import { buildOverrideScript, MAKINA_OVERRIDES } from '../src/overrides.js';

const HTML = `<!doctype html><meta charset=utf8><body>
  <nav><a>Explore</a><a>Portfolio</a><a>Points</a></nav>
  <section class="donut"><div>Portfolio</div><div>$4</div></section>
  <div class="legend"><span>USDSHFMK</span><span>100.00% $4</span></div>
  <table>
    <tr><td>Season 0</td><td>36.52</td></tr>
    <tr><td>Season 1</td><td>134.6561</td></tr>
    <tr><td>Season 2</td><td>141.5327</td></tr>
    <tr><td>Season 3</td><td>62.3086</td></tr>
  </table>
  <div class="avail">3.9105 usdSHFmk avail.</div>
  <div class="avail">0.358624 USDC avail.</div>
</body>`;

const browser = await launchChromium();
const page = await browser.newPage();
await page.addInitScript({ content: buildOverrideScript(MAKINA_OVERRIDES) });
await page.goto('data:text/html,' + encodeURIComponent(HTML), { waitUntil: 'load' });
// Simulate an SPA re-render to prove the observer re-applies.
await page.evaluate(() => { document.querySelector('.avail')!.textContent = '3.9105 usdSHFmk avail.'; });
await page.waitForTimeout(600);

const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
await browser.close();

const want = ['$52,480', '1,204.52', '4,865.61', '6,142.33', '3,908.09', '51,204.88', '8,650.42'];
const gone = ['36.52', '134.6561', '3.9105', '0.358624'];
const missing = want.filter((w) => !text.includes(w));
const leftover = gone.filter((g) => text.includes(g));

console.log('RESULT:', text);
console.log('missing replacements:', missing);
console.log('leftover originals:', leftover);
const ok = missing.length === 0 && leftover.length === 0;
console.log(ok ? '\nOVERRIDE TEST: PASS' : '\nOVERRIDE TEST: FAIL');
process.exit(ok ? 0 : 1);
