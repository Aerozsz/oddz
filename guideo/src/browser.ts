import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Resolve a Chromium binary the user has pointed us at, or one pre-installed in
 * a managed environment (whose build number may not match the npm Playwright
 * version). Returns undefined to let Playwright use its own downloaded browser.
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
      for (const rel of ['chrome-linux/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const bin = path.join(base, d, rel);
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}

/** Is a usable Chromium already present (either ours or Playwright's)? */
function haveBrowser(): boolean {
  if (resolveChromium()) return true;
  try {
    const exe = chromium.executablePath();
    return !!exe && existsSync(exe);
  } catch {
    return false;
  }
}

let installing: Promise<void> | null = null;

/**
 * Make sure a Chromium is available, downloading it once via Playwright if not.
 * Safe to call repeatedly; concurrent calls share one install. `onLog` streams
 * progress so a UI can show what's happening.
 */
export async function ensureBrowser(onLog?: (msg: string) => void): Promise<void> {
  if (haveBrowser()) return;
  if (installing) return installing;
  installing = new Promise<void>((resolve, reject) => {
    onLog?.('Setting up the browser Guideo needs (one-time download, ~1 minute)…');
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'npx.cmd' : 'npx';
    const child = spawn(bin, ['playwright', 'install', 'chromium'], {
      shell: isWin,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const relay = (buf: Buffer) => {
      const s = buf.toString().trim();
      if (s) onLog?.(s.split('\n').pop() || s);
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        onLog?.('Browser ready.');
        resolve();
      } else {
        reject(new Error('Could not download the browser (playwright install exited ' + code + '). Check your internet connection.'));
      }
    });
  }).finally(() => {
    installing = null;
  });
  return installing;
}

export async function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  const executablePath = resolveChromium();
  try {
    return await chromium.launch({ headless: true, executablePath, ...opts });
  } catch (err: any) {
    // Self-heal the common "browser not installed yet" case, then retry once.
    if (!executablePath && /Executable doesn't exist|playwright install/i.test(err?.message || '')) {
      await ensureBrowser();
      return chromium.launch({ headless: true, ...opts });
    }
    throw err;
  }
}
