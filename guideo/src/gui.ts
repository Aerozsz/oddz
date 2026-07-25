import http from 'node:http';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explore } from './explore.js';
import { buildPlayer } from './build-player.js';
import { renderVideo, renderVideoFromHtml, guideFromHtml, renderStills } from './render.js';
import { buildExport, type ExportFormat } from './export.js';
import { buildDocsite, writeDocsite } from './docsite.js';
import { buildVocsProject } from './vocs.js';
import { makeZip } from './zip.js';
import type { Guide } from './types.js';
import { serveDir } from './server.js';
import { ensureBrowser } from './browser.js';
import { makeWalletConfig, ethToWei, type WalletConfig } from './wallet.js';
import { presetForHost, type OverrideRule } from './overrides.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(here, 'gui');
const DEMO_SITE = path.join(here, 'demo-site');
const GUIDES = path.join(here, '..', 'guides');

interface Job {
  id: string;
  guideId: string;
  status: 'running' | 'done' | 'error';
  phase: string;
  progress: number; // 0..100, -1 = indeterminate
  events: any[];
  listeners: Set<http.ServerResponse>;
  error?: string;
  hasVideo: boolean;
}

const jobs = new Map<string, Job>();

/** Bump when the GUI gains features, so users can confirm they're up to date. */
export const GUI_VERSION = '0.23.0 · static docs-site is the recommended deploy (Vocs is SSR source)';

function emit(job: Job, ev: any) {
  const withTs = { ...ev, t: Date.now() };
  job.events.push(withTs);
  const line = `data: ${JSON.stringify(withTs)}\n\n`;
  for (const res of job.listeners) res.write(line);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function hostSlug(url: string) {
  try {
    return new URL(url).hostname.replace(/\W+/g, '-');
  } catch {
    return 'guide';
  }
}

async function runJob(job: Job, params: any) {
  const outDir = path.join(GUIDES, job.guideId);
  await mkdir(outDir, { recursive: true });
  let demoServer: { url: string; close: () => Promise<void> } | null = null;
  try {
    let url: string = params.url;
    let title: string | undefined = params.title || undefined;

    // Simulated wallet (opt-in), for web3 / dapp sites.
    let wallet: WalletConfig | undefined;
    if (params.wallet || params.assist) {
      wallet = makeWalletConfig({
        ...(params.address ? { address: params.address } : {}),
        ...(params.chain ? { chainId: params.chain } : {}),
        ...(params.balanceEth ? { nativeBalanceWei: ethToWei(String(params.balanceEth)) } : {}),
      });
    }

    if (params.mode === 'demo') {
      demoServer = await serveDir(DEMO_SITE);
      url = wallet ? demoServer.url + '/app.html' : demoServer.url;
      title = title || (wallet ? 'How to use the TaskFlow Vault' : 'How to use TaskFlow');
      emit(job, { type: 'log', msg: `Serving bundled demo site at ${demoServer.url}` });
    }

    job.phase = 'preparing';
    emit(job, { type: 'phase', phase: 'preparing', msg: 'Getting ready…' });
    await ensureBrowser((m) => emit(job, { type: 'log', msg: '  ' + m }));
    if (wallet) emit(job, { type: 'log', msg: `Using a simulated wallet (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}).` });

    job.phase = 'exploring';
    emit(job, { type: 'phase', phase: 'exploring', msg: `Exploring ${url} like a first-time user…` });
    // Test-number overrides (built-in preset for known hosts).
    let overrides: OverrideRule[] | undefined;
    if ((params.wallet || params.assist) && params.fill !== false && params.mode === 'url') {
      overrides = presetForHost(params.url);
      if (overrides) emit(job, { type: 'log', msg: `Applying ${overrides.length} test-number overrides for this site.` });
    }

    if (params.assist) {
      emit(job, { type: 'log', msg: 'A browser window will open on your screen — connect the wallet there to continue.' });
    }
    const guide = await explore({
      url,
      outDir,
      maxSteps: params.maxSteps || 14,
      title,
      wallet,
      assist: !!params.assist,
      pace: params.pace ? Number(params.pace) : undefined,
      overrides,
      onNote: (m) => emit(job, { type: 'log', msg: m }),
      onStep: (count, stepTitle) => {
        emit(job, { type: 'log', msg: `  · captured step ${count}: ${stepTitle}` });
        job.progress = Math.min(40, count * 3);
        emit(job, { type: 'progress', progress: job.progress });
      },
    });
    emit(job, { type: 'log', msg: `Captured ${guide.steps.length} steps.` });

    job.phase = 'building';
    emit(job, { type: 'phase', phase: 'building', msg: 'Baking self-contained player.html…' });
    await buildPlayer(outDir, guide);
    job.progress = 45;
    emit(job, { type: 'progress', progress: 45 });

    if (params.video) {
      job.phase = 'rendering';
      emit(job, { type: 'phase', phase: 'rendering', msg: 'Rendering MP4 (this is the slow part)…' });
      await renderVideo({
        guideDir: outDir,
        fps: params.fps || 25,
        height: params.height || undefined,
        onProgress: (done, total) => {
          job.progress = 45 + Math.round((done / total) * 55);
          emit(job, { type: 'progress', progress: job.progress });
        },
      });
      job.hasVideo = true;
      emit(job, { type: 'log', msg: 'MP4 rendered.' });
    }

    job.status = 'done';
    job.phase = 'done';
    job.progress = 100;
    emit(job, {
      type: 'done',
      guideId: job.guideId,
      hasVideo: job.hasVideo,
      capture: !!wallet,
      steps: guide.steps.length,
      title: guide.meta.title,
    });
  } catch (err: any) {
    job.status = 'error';
    job.error = err?.message || String(err);
    emit(job, { type: 'error', msg: job.error });
  } finally {
    if (demoServer) await demoServer.close();
  }
}

/** Run `vercel deploy <siteDir>`, stream logs, resolve the live URL. */
async function deployDirectory(job: Job, siteDir: string, params: any): Promise<void> {
  const token = (params.token && String(params.token).trim()) || process.env.VERCEL_TOKEN || '';
  job.phase = 'deploying';
  emit(job, { type: 'phase', phase: 'deploying', msg: 'Deploying to Vercel…' });
  const args = ['vercel', 'deploy', siteDir, '--yes'];
  if (params.prod) args.push('--prod');
  if (token) args.push('--token', token);
  emit(job, { type: 'log', msg: 'Running: npx vercel deploy …' + (token ? ' (with token)' : ' (using your Vercel login)') });

  const { spawn } = await import('node:child_process');
  const child = spawn('npx', args, { env: { ...process.env } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { const s = d.toString(); out += s; s.split('\n').forEach((l: string) => l.trim() && emit(job, { type: 'log', msg: l.trim() })); });
  child.stderr.on('data', (d) => { const s = d.toString(); err += s; s.split('\n').forEach((l: string) => l.trim() && emit(job, { type: 'log', msg: l.trim() })); });
  const code: number = await new Promise((resolve) => { child.on('close', (c) => resolve(c ?? 1)); child.on('error', () => resolve(1)); });

  const url = (out + '\n' + err).match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/);
  if (code === 0 && url) {
    job.status = 'done'; job.phase = 'done'; job.progress = 100;
    emit(job, { type: 'done', guideId: job.guideId, deployUrl: url[0], deploy: true });
  } else {
    throw new Error(
      (err || out).includes('credentials') || (err || out).includes('token') || /not authenticated|log ?in/i.test(err + out)
        ? 'Vercel needs authentication. Paste a Vercel token (Account → Settings → Tokens), or run `npx vercel login` once in a terminal, then try again.'
        : 'Vercel deploy failed. ' + (err || out).slice(-400)
    );
  }
}

async function runDeployJob(job: Job, params: any) {
  const dir = path.join(GUIDES, job.guideId);
  try {
    if (!existsSync(dir)) throw new Error('Guide not found.');
    const src = await loadGuideForExport(dir);
    const vocs = params.engine === 'vocs';
    job.phase = 'building';
    emit(job, { type: 'phase', phase: 'building', msg: 'Rendering composited frames…' });
    const stills = await stillsFor(src, (m) => emit(job, { type: 'log', msg: m }));
    emit(job, { type: 'phase', phase: 'building', msg: vocs ? 'Building the Vocs docs project…' : 'Building the docs site…' });
    const siteDir = path.join(dir, vocs ? 'vocs' : 'site');
    await writeDocsite(vocs ? buildVocsProject({ ...src, stills }) : buildDocsite({ ...src, stills }), siteDir);
    if (vocs) emit(job, { type: 'log', msg: 'Vercel will install deps and run the Vocs build (this can take a couple of minutes).' });
    await deployDirectory(job, siteDir, params);
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    emit(job, { type: 'error', msg: job.error });
  }
}

// Persist an uploaded player.html as a library guide so all per-guide actions
// (export, docsite, vocs, deploy) work on it.
async function materializeHtml(html: string, name?: string): Promise<string> {
  const guide = guideFromHtml(html);
  const base = (name ? String(name).replace(/\.html?$/i, '').replace(/\W+/g, '-').slice(0, 40) : '') ||
    (guide.meta?.title ? guide.meta.title.replace(/\W+/g, '-').slice(0, 40) : 'guide');
  const guideId = 'html-' + (base || 'guide') + '-' + stamp();
  const dir = path.join(GUIDES, guideId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'player.html'), html);
  await writeFile(path.join(dir, 'guide.json'), JSON.stringify(guide, null, 2));
  return guideId;
}

async function runDeployHtmlJob(job: Job, params: any) {
  try {
    if (!params.html || typeof params.html !== 'string' || !/id=["']?guide-data/i.test(params.html)) {
      throw new Error('That file is not a Guideo player.html (no embedded guide data).');
    }
    job.phase = 'building';
    emit(job, { type: 'phase', phase: 'building', msg: 'Reading your player.html…' });
    job.guideId = await materializeHtml(params.html, params.name);
    const dir = path.join(GUIDES, job.guideId);
    const src = await loadGuideForExport(dir);
    const vocs = params.engine === 'vocs';
    emit(job, { type: 'phase', phase: 'building', msg: 'Rendering composited frames…' });
    const stills = await stillsFor({ html: params.html }, (m) => emit(job, { type: 'log', msg: m }));
    emit(job, { type: 'phase', phase: 'building', msg: vocs ? 'Building the Vocs docs project…' : 'Building the docs site…' });
    const siteDir = path.join(dir, vocs ? 'vocs' : 'site');
    await writeDocsite(vocs ? buildVocsProject({ ...src, stills }) : buildDocsite({ ...src, stills }), siteDir);
    if (vocs) emit(job, { type: 'log', msg: 'Vercel will install deps and run the Vocs build (this can take a couple of minutes).' });
    await deployDirectory(job, siteDir, params);
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    emit(job, { type: 'error', msg: job.error });
  }
}

async function runHtmlJob(job: Job, params: any) {
  const outDir = path.join(GUIDES, job.guideId);
  await mkdir(outDir, { recursive: true });
  try {
    if (!params.html || typeof params.html !== 'string' || !/id=["']?guide-data/i.test(params.html)) {
      throw new Error('That file is not a Guideo player.html (no embedded guide data found).');
    }
    job.phase = 'preparing';
    emit(job, { type: 'phase', phase: 'preparing', msg: 'Getting ready…' });
    await ensureBrowser((m) => emit(job, { type: 'log', msg: '  ' + m }));

    job.phase = 'rendering';
    emit(job, { type: 'phase', phase: 'rendering', msg: 'Rendering MP4 from your edited guide…' });
    const out = path.join(outDir, 'guide.mp4');
    await renderVideoFromHtml({
      html: params.html,
      out,
      fps: params.fps || 25,
      width: params.width || undefined,
      height: params.height || undefined,
      onLog: (m) => emit(job, { type: 'log', msg: '  ' + m }),
      onProgress: (done, total) => {
        job.progress = Math.round((done / total) * 100);
        emit(job, { type: 'progress', progress: job.progress });
      },
    });
    // Keep the source player next to the MP4 so the guide stays openable.
    await writeFile(path.join(outDir, 'player.html'), params.html);

    job.hasVideo = true;
    job.status = 'done';
    job.phase = 'done';
    job.progress = 100;
    emit(job, { type: 'done', guideId: job.guideId, hasVideo: true, fromHtml: true });
  } catch (err: any) {
    job.status = 'error';
    job.error = err?.message || String(err);
    emit(job, { type: 'error', msg: job.error });
  }
}

/** Render composited stills (caption/highlights baked in) for image exports.
 *  Falls back to undefined (raw screenshots) if the browser render fails. */
async function stillsFor(input: { guide?: Guide; guideDir?: string; html?: string }, onLog?: (m: string) => void): Promise<Buffer[] | undefined> {
  try {
    await ensureBrowser(() => {});
    return await renderStills(input.html ? { html: input.html } : { guide: input.guide, guideDir: input.guideDir });
  } catch (e: any) {
    onLog?.('Could not render composited frames (' + (e?.message || e) + '); using raw screenshots.');
    return undefined;
  }
}

/** Load a guide (+ its MP4, if rendered) from a guide directory for export. */
async function loadGuideForExport(dir: string): Promise<{ guide: Guide; guideDir: string; mp4: Buffer | null }> {
  const gj = path.join(dir, 'guide.json');
  const ph = path.join(dir, 'player.html');
  let guide: Guide;
  if (existsSync(gj)) guide = JSON.parse(await readFile(gj, 'utf8'));
  else if (existsSync(ph)) guide = guideFromHtml(await readFile(ph, 'utf8'));
  else throw new Error('This guide has no guide.json or player.html to export.');
  const mp4Path = path.join(dir, 'guide.mp4');
  const mp4 = existsSync(mp4Path) ? await readFile(mp4Path) : null;
  return { guide, guideDir: dir, mp4 };
}

function sendZip(res: http.ServerResponse, zip: Buffer, filename: string) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  }).end(zip);
}

async function listGuides() {
  if (!existsSync(GUIDES)) return [];
  const dirs = await readdir(GUIDES);
  const out: any[] = [];
  for (const d of dirs) {
    const gj = path.join(GUIDES, d, 'guide.json');
    if (!existsSync(gj)) continue;
    try {
      const guide = JSON.parse(await readFile(gj, 'utf8'));
      const st = await stat(gj);
      out.push({
        id: d,
        title: guide.meta?.title || d,
        site: guide.meta?.site || '',
        steps: guide.steps?.length || 0,
        hasVideo: existsSync(path.join(GUIDES, d, 'guide.mp4')),
        hasPlayer: existsSync(path.join(GUIDES, d, 'player.html')),
        createdAt: guide.meta?.createdAt || st.mtime.toISOString(),
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function serveFile(res: http.ServerResponse, file: string, download = false) {
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const body = await readFile(file);
  const headers: Record<string, string> = {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    // Never cache: the GUI must always reflect the installed version.
    'cache-control': 'no-store, must-revalidate',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(200, headers).end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

export async function startGui(port = 4600): Promise<{ url: string }> {
  await mkdir(GUIDES, { recursive: true });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    const p = decodeURIComponent(u.pathname);
    try {
      // ---- API ----
      if (p === '/api/version' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ version: GUI_VERSION }));
        return;
      }
      if (p === '/api/guides' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await listGuides()));
        return;
      }
      if (p === '/api/run' && req.method === 'POST') {
        const params = await readBody(req);
        if (params.mode !== 'demo' && !/^https?:\/\//i.test(params.url || '')) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Enter a URL starting with http:// or https://' }));
          return;
        }
        const id = 'job-' + Date.now();
        const guideId = (params.mode === 'demo' ? 'demo-' : hostSlug(params.url) + '-') + stamp();
        const job: Job = { id, guideId, status: 'running', phase: 'starting', progress: 0, events: [], listeners: new Set(), hasVideo: false };
        jobs.set(id, job);
        runJob(job, params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobId: id, guideId }));
        return;
      }
      if (p === '/api/render-html' && req.method === 'POST') {
        const params = await readBody(req);
        if (!params.html || typeof params.html !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No player.html content was received.' }));
          return;
        }
        const id = 'job-' + Date.now();
        const base = (params.name ? String(params.name).replace(/\.html?$/i, '').replace(/\W+/g, '-').slice(0, 40) : 'edited') || 'edited';
        const guideId = 'mp4-' + base + '-' + stamp();
        const job: Job = { id, guideId, status: 'running', phase: 'starting', progress: 0, events: [], listeners: new Set(), hasVideo: false };
        jobs.set(id, job);
        runHtmlJob(job, params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobId: id, guideId }));
        return;
      }
      // Export an edited player.html directly to a shareable .zip (no render).
      if (p === '/api/export-html' && req.method === 'POST') {
        const params = await readBody(req);
        const format = String(params.format || '').toLowerCase() as ExportFormat;
        if (format !== 'gitbook' && format !== 'social') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'format must be gitbook or social' }));
          return;
        }
        if (!params.html || typeof params.html !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No player.html content was received.' }));
          return;
        }
        try {
          const guide = guideFromHtml(params.html);
          const stills = await stillsFor({ html: params.html });
          const { zip, filename } = buildExport(format, { guide, stills });
          sendZip(res, zip, filename);
        } catch (err: any) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }
      // Build a real Vocs project straight from an uploaded player.html (zip).
      if (p === '/api/vocs-html' && req.method === 'POST') {
        const params = await readBody(req);
        if (!params.html || typeof params.html !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No player.html content was received.' }));
          return;
        }
        try {
          const guide = guideFromHtml(params.html);
          const stills = await stillsFor({ html: params.html });
          const files = buildVocsProject({ guide, stills });
          const zip = makeZip(files.map((f) => ({ name: f.file, data: Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8') })));
          sendZip(res, zip, (guide.meta?.title ? guide.meta.title.replace(/\W+/g, '-').slice(0, 40) : 'guide') + '-vocs-project.zip');
        } catch (err: any) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }
      // Deploy straight from an uploaded player.html (static or Vocs), streamed.
      if (p === '/api/deploy-html' && req.method === 'POST') {
        const params = await readBody(req);
        if (!params.html || typeof params.html !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No player.html content was received.' }));
          return;
        }
        const id = 'job-' + Date.now();
        const job: Job = { id, guideId: '', status: 'running', phase: 'starting', progress: -1, events: [], listeners: new Set(), hasVideo: false };
        jobs.set(id, job);
        runDeployHtmlJob(job, params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobId: id }));
        return;
      }
      // Build the styled docs site for a guide and return its preview URL
      // (or ?zip=1 to download it as a deploy-ready archive).
      const dsMatch = p.match(/^\/api\/docsite\/([^/]+)$/);
      if (dsMatch && req.method === 'GET') {
        const dir = path.join(GUIDES, dsMatch[1]);
        if (!dir.startsWith(GUIDES) || !existsSync(dir)) { res.writeHead(404).end('no such guide'); return; }
        try {
          const src = await loadGuideForExport(dir);
          const stills = await stillsFor(src);
          const files = buildDocsite({ ...src, stills });
          if (u.searchParams.get('zip') === '1') {
            const zip = makeZip(files.map((f) => ({ name: f.file, data: Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8') })));
            sendZip(res, zip, (src.guide.meta?.title ? src.guide.meta.title.replace(/\W+/g, '-').slice(0, 40) : 'guide') + '-docs-site.zip');
            return;
          }
          await writeDocsite(files, path.join(dir, 'site'));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ url: '/guides/' + dsMatch[1] + '/site/index.html' }));
        } catch (err: any) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err?.message || String(err) }));
        }
        return;
      }
      // Deploy a guide's docs site to Vercel (streamed as a job).
      const depMatch = p.match(/^\/api\/deploy\/([^/]+)$/);
      if (depMatch && req.method === 'POST') {
        const dir = path.join(GUIDES, depMatch[1]);
        if (!dir.startsWith(GUIDES) || !existsSync(dir)) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no such guide' })); return; }
        const params = await readBody(req);
        const id = 'job-' + Date.now();
        const job: Job = { id, guideId: depMatch[1], status: 'running', phase: 'starting', progress: -1, events: [], listeners: new Set(), hasVideo: false };
        jobs.set(id, job);
        runDeployJob(job, params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobId: id }));
        return;
      }
      // Download a real Vocs project (Makina-themed) as a .zip.
      const vocsMatch = p.match(/^\/api\/vocs\/([^/]+)$/);
      if (vocsMatch && req.method === 'GET') {
        const dir = path.join(GUIDES, vocsMatch[1]);
        if (!dir.startsWith(GUIDES) || !existsSync(dir)) { res.writeHead(404).end('no such guide'); return; }
        try {
          const src = await loadGuideForExport(dir);
          const stills = await stillsFor(src);
          const files = buildVocsProject({ ...src, stills });
          const zip = makeZip(files.map((f) => ({ name: f.file, data: Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8') })));
          sendZip(res, zip, (src.guide.meta?.title ? src.guide.meta.title.replace(/\W+/g, '-').slice(0, 40) : 'guide') + '-vocs-project.zip');
        } catch (err: any) {
          res.writeHead(400).end('Vocs export failed: ' + (err?.message || err));
        }
        return;
      }
      // Export an existing guide (from the library) to a shareable .zip.
      const exMatch = p.match(/^\/api\/export\/([^/]+)$/);
      if (exMatch && req.method === 'GET') {
        const format = String(u.searchParams.get('format') || '').toLowerCase() as ExportFormat;
        if (format !== 'gitbook' && format !== 'social') { res.writeHead(400).end('bad format'); return; }
        const dir = path.join(GUIDES, exMatch[1]);
        if (!dir.startsWith(GUIDES) || !existsSync(dir)) { res.writeHead(404).end('no such guide'); return; }
        try {
          const src = await loadGuideForExport(dir);
          const stills = await stillsFor(src);
          const { zip, filename } = buildExport(format, { ...src, stills });
          sendZip(res, zip, filename);
        } catch (err: any) {
          res.writeHead(400).end('Export failed: ' + (err?.message || err));
        }
        return;
      }
      const evMatch = p.match(/^\/api\/events\/(.+)$/);
      if (evMatch && req.method === 'GET') {
        const job = jobs.get(evMatch[1]);
        if (!job) {
          res.writeHead(404).end('no such job');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (job.status !== 'running') {
          res.end();
          return;
        }
        job.listeners.add(res);
        req.on('close', () => job.listeners.delete(res));
        return;
      }

      // ---- Guide outputs ----
      if (p.startsWith('/guides/')) {
        const rel = p.slice('/guides/'.length);
        const file = path.join(GUIDES, rel);
        if (!file.startsWith(GUIDES)) {
          res.writeHead(403).end('nope');
          return;
        }
        await serveFile(res, file, u.searchParams.get('dl') === '1');
        return;
      }

      // ---- Static GUI ----
      let file = p === '/' ? path.join(GUI_DIR, 'index.html') : path.join(GUI_DIR, p);
      if (!file.startsWith(GUI_DIR)) file = path.join(GUI_DIR, 'index.html');
      if (!existsSync(file)) file = path.join(GUI_DIR, 'index.html');
      await serveFile(res, file);
    } catch (err: any) {
      res.writeHead(500).end('Error: ' + (err?.message || err));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${actualPort}` };
}
