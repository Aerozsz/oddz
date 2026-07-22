// Electron shell for Guideo. Boots the local GUI server and shows it in a
// native window, so the whole thing feels like a normal desktop app / .exe.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 4611;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc = null;

function startServer() {
  // In dev we run from the repo; when packaged, files live in resources/app.
  const cwd = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'npx.cmd' : 'npx';
  serverProc = spawn(bin, ['tsx', 'src/cli.ts', 'gui', '--no-open', '--port', String(PORT)], {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: isWin,
  });
  serverProc.on('error', (e) => console.error('Failed to start Guideo server:', e));
}

function waitForServer(cb, tries = 80) {
  const req = http.get(BASE, () => cb());
  req.on('error', () => (tries > 0 ? setTimeout(() => waitForServer(cb, tries - 1), 300) : cb()));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 860,
    minWidth: 720,
    title: 'Guideo',
    backgroundColor: '#0b0c14',
    autoHideMenuBar: true,
  });
  // Open target=_blank links (the player, downloads) in the system browser,
  // where clipboard and file downloads behave normally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`data:text/html,${encodeURIComponent('<body style="background:#0b0c14;color:#9ea2c4;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div>Starting Guideo…</div></body>')}`);
  waitForServer(() => win.loadURL(BASE));
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProc) try { serverProc.kill(); } catch {}
  app.quit();
});
app.on('quit', () => {
  if (serverProc) try { serverProc.kill(); } catch {}
});
