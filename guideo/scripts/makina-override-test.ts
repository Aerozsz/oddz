import { launchChromium } from '../src/browser.js';
import { buildOverrideScript, MAKINA_OVERRIDES } from '../src/overrides.js';

// Replica of makina's Portfolio + Points + Explore text (from screenshots).
const HTML = `<!doctype html><meta charset=utf8><body>
  <!-- Explore -->
  <div>TOTAL TVL <span>$49,861,746</span></div>
  <div class="card"><span>Steakhouse USD</span><div>4.79%</div><div>LIVE APY - 30D</div><div>TVL</div><div>24.31M usdSHFmk</div></div>
  <div class="card"><span>Dialectic BTC</span><div>0.44%</div><div>TVL</div><div>9.66 DBIT</div></div>
  <!-- Portfolio -->
  <div class="donut"><div>Portfolio</div><div>$4</div></div>
  <div class="legend"><span>USDSHFMK</span><span>100.00%</span><span>$4</span></div>
  <div class="prow"><span>USDSHFMK</span><span>Ethereum</span><span>3.9105</span><span>4.79% + 218.75 points per day per $1000</span></div>
  <!-- Points -->
  <table>
    <tr><td>Season 0</td><td>36.52</td></tr>
    <tr><td>Season 1</td><td>134.6561</td></tr>
    <tr><td>Season 2</td><td>141.5327</td></tr>
    <tr><td>Season 3</td><td>62.3086</td></tr>
  </table>
  <div class="swap">3.3586 USDC avail.</div>
</body>`;

const browser = await launchChromium();
const page = await browser.newPage();
await page.addInitScript({ content: buildOverrideScript(MAKINA_OVERRIDES) });
await page.goto('data:text/html,' + encodeURIComponent(HTML), { waitUntil: 'load' });
await page.waitForTimeout(600);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
await browser.close();

const want = ['$52,480', '51,204.88', '12.40%', '890.25', '1,204.52', '4,865.61', '6,142.33', '3,908.09', '8,650.42'];
const keep = ['$49,861,746', '24.31M usdSHFmk', '9.66 DBIT', '0.44%'];
const gone = ['3.9105', '218.75', '36.52', '134.6561', '$4 '];
const missing = want.filter((w) => !text.includes(w));
const broke = keep.filter((k) => !text.includes(k));
const leftover = gone.filter((g) => text.includes(g));
console.log('TEXT:', text);
console.log('\nmissing new values:', missing);
console.log('broke untouched values:', broke);
console.log('leftover old values:', leftover);
const ok = !missing.length && !broke.length && !leftover.length;
console.log(ok ? '\nMAKINA OVERRIDE TEST: PASS' : '\nMAKINA OVERRIDE TEST: FAIL');
process.exit(ok ? 0 : 1);
