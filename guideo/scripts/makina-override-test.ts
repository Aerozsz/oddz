import { launchChromium } from '../src/browser.js';
import { buildOverrideScript, MAKINA_OVERRIDES } from '../src/overrides.js';

// Demo-wallet state: makina shows $0 / 0 / empty for an address with no holdings.
const HTML = `<!doctype html><meta charset=utf8><body>
  <div>TOTAL TVL <span>$49,861,746</span></div>
  <div class="card"><span>Steakhouse USD</span><div>4.79%</div><div>LIVE APY - 30D</div><div>TVL</div><div>24.31M usdSHFmk</div></div>
  <div class="donut"><div>Portfolio</div><div>$0</div></div>
  <table>
    <tr><td>Season 0</td><td>0</td></tr>
    <tr><td>Season 1</td><td>0</td></tr>
    <tr><td>Season 2</td><td>0</td></tr>
    <tr><td>Season 3</td><td>0</td></tr>
  </table>
  <div class="swap">0 DUSD avail.</div>
  <div class="swap2">0 USDC avail.</div>
</body>`;

const browser = await launchChromium();
const page = await browser.newPage();
await page.addInitScript({ content: buildOverrideScript(MAKINA_OVERRIDES) });
await page.goto('data:text/html,' + encodeURIComponent(HTML), { waitUntil: 'load' });
await page.waitForTimeout(600);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
await browser.close();

const want = ['$52,480', '1,204.52', '4,865.61', '6,142.33', '3,908.09', '8,650.42'];
const keep = ['$49,861,746', '24.31M usdSHFmk', 'Steakhouse USD'];
const missing = want.filter((w) => !text.includes(w));
const broke = keep.filter((k) => !text.includes(k));
console.log('TEXT:', text);
console.log('\nmissing:', missing, '\nbroke:', broke);
const ok = !missing.length && !broke.length;
console.log(ok ? '\nDEMO-WALLET OVERRIDE TEST: PASS' : '\nDEMO-WALLET OVERRIDE TEST: FAIL');
process.exit(ok ? 0 : 1);
