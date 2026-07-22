#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { explore } from './explore.js';
import { buildPlayer } from './build-player.js';
import { renderVideo } from './render.js';
import { serveDir } from './server.js';
import { startGui } from './gui.js';
import { ensureBrowser } from './browser.js';
import { makeWalletConfig, ethToWei, type WalletConfig } from './wallet.js';

function walletFromOpts(opts: any): WalletConfig | undefined {
  if (!opts.wallet) return undefined;
  return makeWalletConfig({
    ...(opts.address ? { address: opts.address } : {}),
    ...(opts.chain ? { chainId: opts.chain } : {}),
    ...(opts.balance ? { nativeBalanceWei: ethToWei(opts.balance) } : {}),
  });
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
  .option('--address <0x>', 'demo wallet address')
  .option('--chain <hex>', 'chain id, e.g. 0x1 (Ethereum) or 0x2105 (Base)')
  .option('--balance <eth>', 'demo native balance in ETH')
  .option('--pace <n>', 'step speed multiplier (>1 = slower)', parseFloat, 1.35)
  .action(async (url, opts) => {
    const out = opts.out || path.join(GUIDES, host(url) + '-' + stamp());
    await mkdir(out, { recursive: true });
    await ensureBrowser((m) => log('   ' + m));
    log(`\n🔎 Exploring ${url}`);
    const guide = await explore({ url, outDir: out, maxSteps: opts.max, title: opts.title, wallet: walletFromOpts(opts), pace: opts.pace });
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
  .option('--pace <n>', 'step speed multiplier (>1 = slower)', parseFloat, 1.35)
  .action(async (opts) => {
    const out = opts.out || path.join(GUIDES, 'demo-' + stamp());
    await mkdir(out, { recursive: true });
    await ensureBrowser((m) => log('   ' + m));
    const server = await serveDir(DEMO_SITE);
    log(`\n🌐 Serving demo site at ${server.url}`);
    try {
      log(`🔎 Exploring like a first-time user…`);
      const wallet = opts.wallet ? makeWalletConfig() : undefined;
      const startUrl = opts.wallet ? server.url + '/app.html' : server.url;
      const title = opts.wallet ? 'How to use the TaskFlow Vault' : 'How to use TaskFlow';
      const guide = await explore({ url: startUrl, outDir: out, maxSteps: opts.max, title, wallet, pace: opts.pace });
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
  .action(async (dir, opts) => {
    const guideDir = path.resolve(dir);
    await ensureBrowser((m) => log('   ' + m));
    log(`\n🎬 Rendering ${guideDir}`);
    const mp4 = await renderVideo({ guideDir, out: opts.out, fps: opts.fps, width: opts.width, onProgress: bar });
    log(`   → ${mp4}`);
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
