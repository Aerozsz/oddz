import { launchChromium } from './browser.js';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
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

/** Transcode a video/GIF data URI to VP9 WebM — the render Chromium ships
 *  without H.264, so mp4/GIF steps must be converted to render correctly. */
async function toWebmDataUri(dataUri: string, kind: 'video' | 'gif'): Promise<string> {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUri);
  if (!m) return dataUri;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'guideo-media-'));
  try {
    const inExt = kind === 'gif' ? 'gif' : m[1].includes('webm') ? 'webm' : 'mp4';
    const inFile = path.join(dir, 'in.' + inExt);
    const outFile = path.join(dir, 'out.webm');
    await writeFile(inFile, Buffer.from(m[2], 'base64'));
    await new Promise<void>((resolve, reject) => {
      const args = ['-y', '-i', inFile, '-an', '-c:v', 'libvpx-vp9', '-b:v', '1M',
        '-deadline', 'realtime', '-cpu-used', '5', '-pix_fmt', 'yuv420p', outFile];
      const ff = spawn(resolveFfmpeg(), args);
      let e = '';
      ff.stderr.on('data', (d) => (e += d.toString()));
      ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('media transcode failed: ' + e.slice(-400)))));
      ff.on('error', reject);
    });
    return 'data:video/webm;base64,' + (await readFile(outFile)).toString('base64');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Convert any mp4/GIF step media to WebM so the render browser can decode it. */
async function prepareMedia(guide: Guide, log?: (m: string) => void): Promise<void> {
  for (const s of guide.steps) {
    try {
      if ((s as any).gif) {
        (s as any).video = await toWebmDataUri((s as any).gif, 'gif');
        (s as any).gif = null;
        log?.('converted a GIF step for rendering');
      } else if ((s as any).video && !/^data:video\/webm/i.test((s as any).video)) {
        (s as any).video = await toWebmDataUri((s as any).video, 'video');
        log?.('converted a video step for rendering');
      }
    } catch (err) {
      log?.('media convert failed: ' + (err as Error).message);
    }
  }
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

  // Rebuild the interactive player from guide.json (keeps original mp4/GIF media).
  await buildPlayer(opts.guideDir, guide, path.join(opts.guideDir, 'player.html'));

  // For the render, convert any mp4/GIF media to WebM (the render browser has no
  // H.264) — on a separate copy so the interactive player keeps the originals.
  const renderGuide: Guide = JSON.parse(JSON.stringify(guide));
  await prepareMedia(renderGuide);
  const playerPath = await buildPlayer(opts.guideDir, renderGuide, path.join(opts.guideDir, 'render-player.html'));

  const browser = await launchChromium({ headless: true });
  const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 }, deviceScaleFactor: 1 });
  // Render from guide.json, never a browser's saved edits.
  await page.addInitScript('window.__guideoNoRestore = true;');
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
        Promise.resolve((window as any).guideo.seek(ms)).then(
          () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
        ),
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
