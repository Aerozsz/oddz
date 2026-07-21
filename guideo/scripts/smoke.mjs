import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function chromePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const d = readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0];
  return path.join(base, d, 'chrome-linux', 'chrome');
}

const player = path.resolve(process.argv[2] || 'guides/demo-test/player.html');
if (!existsSync(player)) throw new Error('no player at ' + player);

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(pathToFileURL(player).toString(), { waitUntil: 'load' });
await page.evaluate(() => window.guideo.ready);

const duration = await page.evaluate(() => window.guideo.duration());
const stepCount = await page.evaluate(() => window.guideo.getGuide().steps.length);

// Open the Tweak panel and confirm it builds controls.
await page.click('#g-tweak-toggle');
const panelOpen = await page.evaluate(() => document.getElementById('g-tweak').classList.contains('open'));
const selects = await page.locator('#g-tweak select').count();
const inputs = await page.locator('#g-tweak input').count();

// Edit a caption via the DOM and confirm the live guide updates.
await page.evaluate(() => {
  const g = window.guideo.getGuide();
  g.steps[0].caption = 'EDITED-CAPTION';
  window.guideo.rerender();
});
const captionShown = await page.evaluate(() => {
  window.guideo.seek(1);
  return document.getElementById('g-caption').textContent;
});

// Confirm deterministic seek changes the rendered frame.
await page.evaluate(() => window.guideo.seek(0));
const s0 = await page.locator('#stage').screenshot();
await page.evaluate((d) => window.guideo.seek(d * 0.6), duration);
const s1 = await page.locator('#stage').screenshot();

await browser.close();

const ok =
  duration > 1000 &&
  stepCount > 0 &&
  panelOpen &&
  selects >= 3 &&
  inputs >= 2 &&
  captionShown.includes('EDITED-CAPTION') &&
  !s0.equals(s1) &&
  errors.length === 0;

console.log(JSON.stringify({ duration, stepCount, panelOpen, selects, inputs, captionShown, framesDiffer: !s0.equals(s1), errors }, null, 2));
console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
process.exit(ok ? 0 : 1);
