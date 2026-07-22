# Building the Guideo desktop app (.exe / .dmg / AppImage)

This folder turns Guideo into a native desktop app. The app is a thin Electron
window that boots Guideo's local server and shows the control panel — same GUI
you get from `npm run gui`, but in its own window that looks and launches like a
normal installed program.

## Build a Windows installer (.exe)

> A Windows `.exe` must be built **on Windows** (or a Windows CI runner).
> electron-builder packages the OS-native binary and installer; it can't be
> produced or verified from Linux/macOS reliably.

On a Windows machine with [Node.js](https://nodejs.org) installed:

```powershell
cd guideo
npm install
npm install --save-dev electron electron-builder
npm run dist:win
```

The installer lands in `dist-app\Guideo-Setup-<version>.exe`. macOS and Linux
equivalents: `npm run dist:mac` / `npm run dist:linux`.

To just run the desktop window without packaging:

```sh
npm install --save-dev electron
npm run electron
```

## Important: the browser and ffmpeg

Guideo drives a real Chromium (via Playwright) and encodes MP4s with ffmpeg.
These are **not** bundled into the installer by default, because they're large
and platform-specific. On the target machine, make sure one of these is true:

- **Chromium** — run `npx playwright install chromium` once, **or** set
  `GUIDEO_CHROMIUM` to a Chrome/Chromium executable.
- **ffmpeg** (only needed for MP4 output) — have `ffmpeg` on `PATH`, **or** set
  `GUIDEO_FFMPEG` to an ffmpeg binary with libx264. Without it you still get the
  interactive `player.html`; only the MP4 step is skipped.

For a fully self-contained installer you'd add a first-run step that runs
`npx playwright install chromium` and ships an ffmpeg build — wire that into the
NSIS `include` script or an app first-launch check. Left as a deliberate,
documented seam rather than a hidden 400 MB download.

## Don't want to package at all?

You don't have to. The one-click launchers in the project root —
`Start-Guideo.bat` (Windows) and `start-guideo.command` (macOS/Linux) — open the
same GUI in your browser with a double-click, and need no build step.
