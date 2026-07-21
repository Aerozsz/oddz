import { launchChromium } from './browser.js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Guide } from './types.js';
import { buildPlayer } from './build-player.js';

/** Find an ffmpeg with H.264 support. Env override wins, then common paths. */
function resolveFfmpeg(): string {
  if (process.env.GUIDEO_FFMPEG) return process.env.GUIDEO_FFMPEG;
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    if (existsSync(p)) return p;
  }
  return 'ffmpeg';
}

export interface RenderOptions {
  guideDir: string;
  out?: string;
  fps?: number;
  width?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Force the player into a clean "film" layout: just the stage, fixed pixels. */
function filmCss(w: number, h: number): string {
  return (
    '.topbar,.controls,#g-tweak-toggle,.tweak{display:none!important}' +
    '.stage-wrap{padding:0!important;place-items:start!important}' +
    'html,body{background:#000!important}' +
    '.stage{max-width:none!important;width:' + w + 'px!important;height:' + h + 'px!important;' +
    'aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}'
  );
}

export async function renderVideo(opts: RenderOptions): Promise<string> {
  const guide: Guide = JSON.parse(await readFile(path.join(opts.guideDir, 'guide.json'), 'utf8'));
  const vw = guide.meta.viewport.width;
  const vh = guide.meta.viewport.height;
  const width = even(opts.width ?? vw);
  const height = even(Math.round((width * vh) / vw));
  const fps = opts.fps ?? 25;
  const out = opts.out ?? path.join(opts.guideDir, 'guide.mp4');

  // Always rebuild the player from guide.json so tweaks/edits are reflected.
  const playerPath = await buildPlayer(opts.guideDir, guide, path.join(opts.guideDir, 'player.html'));

  const browser = await launchChromium({ headless: true });
  const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(playerPath).toString(), { waitUntil: 'load' });
  await page.addStyleTag({ content: filmCss(width, height) });
  await page.evaluate(() => (window as any).guideo.ready);
  await page.waitForTimeout(150);

  const duration: number = await page.evaluate(() => (window as any).guideo.duration());
  const totalFrames = Math.max(1, Math.ceil((duration / 1000) * fps));
  const stage = page.locator('#stage');

  const ffmpegPath = resolveFfmpeg();
  const ff = spawn(
    ffmpegPath,
    [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(fps),
      '-i', '-',
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-movflags', '+faststart',
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d.toString()));
  const ffDone = new Promise<void>((resolve, reject) => {
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code + '\n' + ffErr.slice(-1200)))));
    ff.on('error', reject);
  });

  for (let f = 0; f < totalFrames; f++) {
    const t = (f / fps) * 1000;
    await page.evaluate(
      (ms) =>
        new Promise<void>((res) => {
          (window as any).guideo.seek(ms);
          requestAnimationFrame(() => requestAnimationFrame(() => res()));
        }),
      t
    );
    const png = await stage.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (opts.onProgress && (f % 10 === 0 || f === totalFrames - 1)) opts.onProgress(f + 1, totalFrames);
  }

  ff.stdin.end();
  await ffDone;
  await browser.close();
  return out;
}

function even(n: number): number {
  n = Math.round(n);
  return n % 2 === 0 ? n : n + 1;
}
