#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { explore } from './explore.js';
import { buildPlayer } from './build-player.js';
import { renderVideo, renderVideoFromHtml, guideFromHtml, renderStills } from './render.js';
import { buildExport, type ExportFormat } from './export.js';
import { buildDocsite, writeDocsite } from './docsite.js';
import { buildVocsProject } from './vocs.js';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import type { Guide } from './types.js';

/** Load a guide (+ mp4) from a player.html file or a guide directory. */
function loadGuideSource(p: string): { guide: Guide; guideDir?: string; mp4: Buffer | null } {
  const src = path.resolve(p);
  if (/\.html?$/i.test(src)) {
    const guide = guideFromHtml(readFileSync(src, 'utf8'));
    const sib = path.join(path.dirname(src), 'guide.mp4');
    return { guide, mp4: existsSync(sib) ? readFileSync(sib) : null };
  }
  const gj = path.join(src, 'guide.json');
  const ph = path.join(src, 'player.html');
  let guide: Guide;
  if (existsSync(gj)) guide = JSON.parse(readFileSync(gj, 'utf8'));
  else if (existsSync(ph)) guide = guideFromHtml(readFileSync(ph, 'utf8'));
  else throw new Error('No guide.json or player.html found in ' + src);
  const mp4p = path.join(src, 'guide.mp4');
  return { guide, guideDir: src, mp4: existsSync(mp4p) ? readFileSync(mp4p) : null };
}
import { serveDir } from './server.js';
import { startGui } from './gui.js';
import { ensureBrowser } from './browser.js';
import { readFileSync } from 'node:fs';
import { makeWalletConfig, ethToWei, type WalletConfig } from './wallet.js';
import { presetForHost, type OverrideRule } from './overrides.js';

function walletFromOpts(opts: any): WalletConfig | undefined {
  if (!opts.wallet) return undefined;
  return makeWalletConfig({
    ...(opts.address ? { address: opts.address } : {}),
    ...(opts.chain ? { chainId: opts.chain } : {}),
    ...(opts.balance ? { nativeBalanceWei: ethToWei(opts.balance) } : {}),
  });
}

/** Choose override rules: explicit file wins, else a built-in preset for the host. */
function overridesFromOpts(url: string, opts: any): OverrideRule[] | undefined {
  if (opts.overrides) {
    try { return JSON.parse(readFileSync(opts.overrides, 'utf8')); }
    catch (e) { log('   ⚠ could not read overrides file: ' + (e as Error).message); }
  }
  if (opts.fill === false) return undefined;
  if (opts.wallet || opts.assist) return presetForHost(url);
  return undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SITE = path.join(here, 'demo-site');
const GUIDES = path.join(here, '..', 'guides');

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function log(msg: string) {
  process.stdout.write(msg + '\n');
}
function bar(done: number, total: number) {
  const pct = Math.round((done / total) * 100);
  const filled = Math.round(pct / 4);
  process.stdout.write('\r  rendering [' + '█'.repeat(filled) + '░'.repeat(25 - filled) + '] ' + pct + '%  ');
  if (done === total) process.stdout.write('\n');
}

const program = new Command();
program.name('guideo').description('Browse a website like a user and generate an editable video guide.');

program
  .command('explore')
  .argument('<url>', 'URL to explore (http/https)')
  .option('-o, --out <dir>', 'output directory')
  .option('-m, --max <n>', 'max steps', (v) => parseInt(v, 10), 14)
  .option('-t, --title <title>', 'guide title')
  .option('--video', 'also render the MP4', false)
  .option('--wallet', 'inject a simulated crypto wallet and connect it', false)
  .option('--assist', 'open a visible browser so you can connect the wallet yourself', false)
  .option('--address <0x>', 'demo wallet address')
  .option('--chain <hex>', 'chain id, e.g. 0x1 (Ethereum) or 0x2105 (Base)')
  .option('--balance <eth>', 'demo native balance in ETH')
  .option('--overrides <file>', 'JSON file of on-screen number override rules')
  .option('--no-fill', 'do not apply built-in test-number overrides')
  .option('--pace <n>', 'step speed multiplier (>1 = slower)', parseFloat, 1.35)
  .action(async (url, opts) => {
    const out = opts.out || path.join(GUIDES, host(url) + '-' + stamp());
    await mkdir(out, { recursive: true });
    await ensureBrowser((m) => log('   ' + m));
    log(`\n🔎 Exploring ${url}`);
    const wallet = walletFromOpts(opts) || (opts.assist ? makeWalletConfig() : undefined);
    const overrides = overridesFromOpts(url, opts);
    if (overrides) log(`   applying ${overrides.length} test-number overrides`);
    const guide = await explore({
      url, outDir: out, maxSteps: opts.max, title: opts.title,
      wallet, assist: opts.assist, pace: opts.pace, overrides,
      onNote: (m) => log('   ' + m),
    });
    log(`   captured ${guide.steps.length} steps`);
    const player = await buildPlayer(out, guide);
    log(`🧩 Built player  → ${player}`);
    if (opts.video) {
      const mp4 = await renderVideo({ guideDir: out, onProgress: bar });
      log(`🎬 Rendered MP4  → ${mp4}`);
    }
    done(out);
  });

program
  .command('demo')
  .description('Explore the bundled TaskFlow demo site end-to-end')
  .option('-o, --out <dir>', 'output directory')
  .option('-m, --max <n>', 'max steps', (v) => parseInt(v, 10), 16)
  .option('--no-video', 'skip MP4 rendering')
  .option('--fps <n>', 'video frame rate', (v) => parseInt(v, 10), 25)
  .option('--wallet', 'show the wallet-gated demo dapp and connect a demo wallet', false)
  .option('--assist', 'open a visible browser so you can connect the wallet yourself', false)
  .option('--pace <n>', 'step speed multiplier (>1 = slower)', parseFloat, 1.35)
  .action(async (opts) => {
    const out = opts.out || path.join(GUIDES, 'demo-' + stamp());
    await mkdir(out, { recursive: true });
    await ensureBrowser((m) => log('   ' + m));
    const server = await serveDir(DEMO_SITE);
    log(`\n🌐 Serving demo site at ${server.url}`);
    try {
      log(`🔎 Exploring like a first-time user…`);
      const useWallet = opts.wallet || opts.assist;
      const wallet = useWallet ? makeWalletConfig() : undefined;
      const startUrl = useWallet ? server.url + '/app.html' : server.url;
      const title = useWallet ? 'How to use the TaskFlow Vault' : 'How to use TaskFlow';
      const guide = await explore({
        url: startUrl, outDir: out, maxSteps: opts.max, title, wallet,
        assist: opts.assist, pace: opts.pace, onNote: (m) => log('   ' + m),
      });
      log(`   captured ${guide.steps.length} steps`);
      const player = await buildPlayer(out, guide);
      log(`🧩 Built self-contained player → ${player}`);
      if (opts.video) {
        const mp4 = await renderVideo({ guideDir: out, fps: opts.fps, onProgress: bar });
        log(`🎬 Rendered MP4 → ${mp4}`);
      }
    } finally {
      await server.close();
    }
    done(out);
  });

program
  .command('build')
  .description('Rebuild player.html from guide.json (after editing)')
  .argument('[dir]', 'guide directory', '.')
  .action(async (dir) => {
    const player = await buildPlayer(path.resolve(dir));
    log(`🧩 Built player → ${player}`);
  });

program
  .command('render')
  .description('Render guide.json to MP4 (reflects any tweaks)')
  .argument('[dir]', 'guide directory', '.')
  .option('-o, --out <file>', 'output mp4 path')
  .option('--fps <n>', 'frame rate', (v) => parseInt(v, 10), 25)
  .option('--width <px>', 'output width', (v) => parseInt(v, 10))
  .option('--height <px>', 'output height (default 1440); drives width from aspect', (v) => parseInt(v, 10))
  .action(async (dir, opts) => {
    const guideDir = path.resolve(dir);
    await ensureBrowser((m) => log('   ' + m));
    log(`\n🎬 Rendering ${guideDir}`);
    const mp4 = await renderVideo({ guideDir, out: opts.out, fps: opts.fps, width: opts.width, height: opts.height, onProgress: bar });
    log(`   → ${mp4}`);
  });

program
  .command('render-html')
  .description('Render an MP4 from an edited player.html (reflects your saved tweaks)')
  .argument('<file>', 'path to a player.html exported from the player')
  .option('-o, --out <file>', 'output mp4 path')
  .option('--fps <n>', 'frame rate', (v) => parseInt(v, 10), 25)
  .option('--width <px>', 'output width', (v) => parseInt(v, 10))
  .option('--height <px>', 'output height (default 1440); drives width from aspect', (v) => parseInt(v, 10))
  .action(async (file, opts) => {
    const htmlPath = path.resolve(file);
    const out = opts.out ? path.resolve(opts.out) : htmlPath.replace(/\.html?$/i, '') + '.mp4';
    await ensureBrowser((m) => log('   ' + m));
    log(`\n🎬 Rendering ${htmlPath}`);
    const mp4 = await renderVideoFromHtml({
      html: readFileSync(htmlPath, 'utf8'), out, fps: opts.fps, width: opts.width, height: opts.height,
      onProgress: bar, onLog: (m) => log('   ' + m),
    });
    log(`   → ${mp4}`);
  });

program
  .command('export')
  .description('Export a guide to GitBook (Markdown) or a social thread (X/Reddit) as a .zip')
  .argument('<path>', 'a player.html file, or a guide directory')
  .requiredOption('-f, --format <fmt>', 'gitbook | social')
  .option('-o, --out <file>', 'output .zip path')
  .action(async (p, opts) => {
    const fmt = String(opts.format).toLowerCase() as ExportFormat;
    if (fmt !== 'gitbook' && fmt !== 'social') { log('   ⚠ --format must be "gitbook" or "social"'); process.exit(1); }
    const src = path.resolve(p);
    let guide: Guide, guideDir: string | undefined, mp4: Buffer | null = null;
    if (/\.html?$/i.test(src)) {
      guide = guideFromHtml(readFileSync(src, 'utf8'));
      const sibling = path.join(path.dirname(src), 'guide.mp4');
      if (existsSync(sibling)) mp4 = readFileSync(sibling);
    } else {
      guideDir = src;
      const gj = path.join(src, 'guide.json');
      const ph = path.join(src, 'player.html');
      if (existsSync(gj)) guide = JSON.parse(readFileSync(gj, 'utf8'));
      else if (existsSync(ph)) guide = guideFromHtml(readFileSync(ph, 'utf8'));
      else { log('   ⚠ no guide.json or player.html found in ' + src); process.exit(1); return; }
      if (existsSync(path.join(src, 'guide.mp4'))) mp4 = readFileSync(path.join(src, 'guide.mp4'));
    }
    await ensureBrowser((m) => log('   ' + m));
    log('   rendering composited frames…');
    const stills = await renderStills({ guide, guideDir }).catch(() => undefined);
    const res = buildExport(fmt, { guide, guideDir, mp4, stills });
    const out = opts.out ? path.resolve(opts.out) : path.join(process.cwd(), res.filename);
    writeFileSync(out, res.zip);
    log(`📦 Exported ${fmt} → ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
  });

program
  .command('docsite')
  .description('Build a GitBook-style static docs site (Makina theme) from a guide')
  .argument('<path>', 'a player.html file, or a guide directory')
  .option('-o, --out <dir>', 'output directory', 'docs-site')
  .action(async (p, opts) => {
    const src = loadGuideSource(p);
    await ensureBrowser((m) => log('   ' + m));
    log('   rendering composited frames…');
    const stills = await renderStills({ guide: src.guide, guideDir: src.guideDir }).catch(() => undefined);
    const files = buildDocsite({ ...src, stills });
    const out = path.resolve(opts.out);
    const index = await writeDocsite(files, out);
    log(`📖 Built docs site → ${index}`);
    log(`   Preview locally: guideo serve ${out}   (or open the file directly)`);
    log(`   Deploy:          guideo deploy ${out}`);
  });

program
  .command('vocs')
  .description('Emit a real Vocs docs project (Makina theme, one page per section)')
  .argument('<path>', 'a player.html file, or a guide directory')
  .option('-o, --out <dir>', 'output directory', 'vocs-docs')
  .action(async (p, opts) => {
    const src = loadGuideSource(p);
    await ensureBrowser((m) => log('   ' + m));
    log('   rendering composited frames…');
    const stills = await renderStills({ guide: src.guide, guideDir: src.guideDir }).catch(() => undefined);
    const files = buildVocsProject({ ...src, stills });
    const out = path.resolve(opts.out);
    await writeDocsite(files, out); // same writer (path/data tree)
    log(`📗 Built Vocs project → ${out}`);
    log(`   cd ${opts.out} && npm install && npm run dev    (edit MDX in src/pages/)`);
    log(`   Deploy: guideo deploy ${opts.out} --prod        (Vercel runs the Vocs build)`);
  });

program
  .command('deploy')
  .description('Deploy a guide (or a built docs site) to Vercel')
  .argument('<path>', 'a player.html, a guide directory, or a docs-site directory')
  .option('--prod', 'deploy to production (default is a preview URL)', false)
  .option('--name <name>', 'Vercel project name')
  .action(async (p, opts) => {
    const src = path.resolve(p);
    // If it already looks like a built site, deploy it as-is; else build one.
    let siteDir: string;
    if (existsSync(path.join(src, 'index.html')) || existsSync(path.join(src, 'package.json'))) {
      // Already a built static site, or a Vocs project Vercel can build.
      siteDir = src;
    } else {
      const source = loadGuideSource(p);
      siteDir = path.join(process.cwd(), '.guideo-site');
      await writeDocsite(buildDocsite(source), siteDir);
      log(`📖 Built docs site → ${siteDir}`);
    }
    log(`\n🚀 Deploying ${siteDir} to Vercel…`);
    const args = ['vercel', 'deploy', siteDir, '--yes'];
    if (opts.prod) args.push('--prod');
    if (opts.name) args.push('--name', opts.name);
    log(`   Running: npx ${args.join(' ')}`);
    log(`   (needs a Vercel login/token — follow any prompt, or set VERCEL_TOKEN)`);
    const child = spawn('npx', args, { stdio: 'inherit' });
    child.on('close', (code) => process.exit(code || 0));
  });

program
  .command('gui')
  .description('Open the point-and-click desktop control panel in your browser')
  .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4600)
  .option('--no-open', "don't auto-open the browser")
  .action(async (opts) => {
    const { url } = await startGui(opts.port);
    log(`\n🖥️  Guideo control panel running at ${url}`);
    if (opts.open !== false) {
      openBrowser(url);
      log(`   (opening your browser… if it didn't, paste that address in)`);
    }
    log(`   Press Ctrl-C to stop.\n`);
    await new Promise(() => {}); // keep alive
  });

program
  .command('serve')
  .description('Serve a guide directory so you can open player.html in a browser')
  .argument('[dir]', 'directory to serve', '.')
  .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4321)
  .action(async (dir, opts) => {
    const server = await serveDir(path.resolve(dir), opts.port);
    log(`\n🌐 Serving ${path.resolve(dir)}`);
    log(`   open ${server.url}/player.html`);
    log(`   (Ctrl-C to stop)`);
    await new Promise(() => {}); // keep alive
  });

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* user can open manually */ }
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/\W+/g, '-');
  } catch {
    return 'guide';
  }
}
function done(out: string) {
  log(`\n✅ Done. Files in ${out}`);
  log(`   • guide.json    – editable source of truth`);
  log(`   • player.html   – open in a browser; use the ✦ Tweak button to edit`);
  log(`   • guide.mp4     – shareable video (if rendered)`);
  log(`   • recording.webm– raw screen recording\n`);
  log(`   View it:  npm run serve -- ${out}\n`);
}

program.parseAsync().catch((err) => {
  console.error('\n✗ ' + (err?.stack || err?.message || err));
  process.exit(1);
});
