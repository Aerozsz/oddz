import http from 'node:http';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explore } from './explore.js';
import { buildPlayer } from './build-player.js';
import { renderVideo } from './render.js';
import { serveDir } from './server.js';
import { ensureBrowser } from './browser.js';
import { makeWalletConfig, ethToWei, type WalletConfig } from './wallet.js';

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
    if (params.wallet) {
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
    const guide = await explore({
      url,
      outDir,
      maxSteps: params.maxSteps || 14,
      title,
      wallet,
      pace: params.pace ? Number(params.pace) : undefined,
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function serveFile(res: http.ServerResponse, file: string, download = false) {
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const body = await readFile(file);
  const headers: Record<string, string> = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
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
