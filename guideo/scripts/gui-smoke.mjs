import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import path from 'node:path';

function chromePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const d = readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0];
  return path.join(base, d, 'chrome-linux', 'chrome');
}

const URL = process.argv[2] || 'http://127.0.0.1:4600';
const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'load' });

// Switch to demo mode, make it quick: uncheck video, set 6 steps.
await page.click('#mode button[data-mode="demo"]');
await page.uncheck('#video');
await page.fill('#max', '6');
await page.click('#run');

// Wait for the result card to appear (job runs explore+build).
await page.waitForSelector('#result.show', { timeout: 120000 });

const phase = await page.textContent('#phase');
const logText = await page.textContent('#log');
const playerHref = await page.getAttribute('#result-actions a', 'href');
const libCount = await page.locator('#lib .item').count();

// Follow the player link and confirm the baked player boots.
const playerUrl = new global.URL(playerHref, URL).toString();
const p2 = await browser.newPage();
await p2.goto(playerUrl, { waitUntil: 'load' });
await p2.evaluate(() => window.guideo.ready);
const dur = await p2.evaluate(() => window.guideo.duration());

await browser.close();

const ok = phase.includes('Done') && /captured step/.test(logText) && !!playerHref && libCount >= 1 && dur > 1000 && errors.length === 0;
console.log(JSON.stringify({ phase, playerHref, libCount, playerDuration: dur, errors }, null, 2));
console.log(ok ? '\nGUI SMOKE: PASS' : '\nGUI SMOKE: FAIL');
process.exit(ok ? 0 : 1);
