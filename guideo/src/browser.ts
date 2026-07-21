import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a Chromium binary. The managed environment pre-installs a browser
 * whose build number may not match the npm Playwright version, so we point
 * Playwright at the on-disk binary instead of letting it download one.
 */
function resolveChromium(): string | undefined {
  if (process.env.GUIDEO_CHROMIUM && existsSync(process.env.GUIDEO_CHROMIUM)) {
    return process.env.GUIDEO_CHROMIUM;
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    const dirs = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort();
    for (const d of dirs.reverse()) {
      const bin = path.join(base, d, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined; // fall back to Playwright's own resolution
}

export async function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  const executablePath = resolveChromium();
  return chromium.launch({ headless: true, executablePath, ...opts });
}
