# Guideo

**Browse a website like a user would, and turn it into an editable video guide for beginners.**

Point Guideo at a URL. It opens a real browser, explores the site the way a
first-time visitor would — clicking through the nav, trying the search box,
filling in a form — and captures each moment. It then produces:

- **`player.html`** — a self-contained, shareable walkthrough that plays like a
  video (Ken Burns motion, animated pointer, spotlight highlights, captions),
  with a built-in **Tweak studio** to edit every word, image, animation and
  timing by clicking buttons and filling fields. No code.
- **`guide.mp4`** — a real H.264 video, rendered from the *same* player, so
  anything you change in the Tweak studio shows up in the video too.
- **`guide.json`** — the editable source of truth.
- **`recording.webm`** — the raw screen recording of the browse session.

Captions are written automatically in plain, beginner-friendly language.
Everything runs locally — no API keys, no external services.

## Quick start

```sh
npm install
npm run demo          # explore the bundled TaskFlow demo site → player.html + guide.mp4
npm run serve -- guides/demo-<timestamp>   # open the printed URL, click ✦ Tweak
```

`npm run demo` needs no network — it serves a small demo app that ships with
Guideo. To point it at a real site:

```sh
npm run explore -- https://example.com --video
```

## How it works

```
explore ──▶ guide.json + screenshots + recording.webm
   │         (Playwright drives the browser autonomously and safely)
   ▼
build   ──▶ player.html   (screenshots inlined as data URIs → one portable file)
   │
   ▼
render  ──▶ guide.mp4      (re-plays player.html frame-by-frame → ffmpeg → H.264)
```

The player is **deterministic**: it renders any millisecond of the guide from
state alone, so the renderer can seek to each frame and screenshot an identical
picture. That's why the MP4 always matches the player — including your edits.

### The single source of truth: `guide.json`

Each step is one screenshot plus how to present it:

```jsonc
{
  "title": "Search",
  "caption": "Click the search box and start typing — the list filters instantly.",
  "image": "screenshots/step-09.png",
  "durationMs": 3800,
  "animation": "fade",                       // none | fade | kenburns-in/out | pan-left/right
  "cursor":    { "x": 0.32, "y": 0.41, "click": true },   // normalized 0..1
  "highlight": { "x": 0.06, "y": 0.36, "w": 0.72, "h": 0.07 },
  "action":    { "type": "click", "target": "search" }
}
```

Positions are normalized to the capture viewport, so a guide renders identically
at any output resolution.

## The Tweak studio

Open `player.html` in a browser and click **✦ Tweak**. You can:

- **Guide & style** — title, accent colour, caption/cursor colours, font.
- **Per step** (pick from a dropdown):
  - Rewrite the **title** and **caption**.
  - Choose an **animation** and drag the **duration**.
  - Show/hide the **pointer**, drag its X/Y, toggle the click ripple.
  - Turn on a **spotlight box** and drag its position/size.
  - **Replace the screenshot** with your own image.
  - **Reorder, duplicate or delete** steps.
- **Export** — download the edited `guide.json` or a fresh self-contained
  `player.html`, or copy the JSON.

Everything previews live. To bake your edits into a new video, save the edited
`guide.json` back into the guide folder and re-run `render`.

## Commands

```sh
npm run explore -- <url> [--out dir] [--max n] [--title "..."] [--video]
npm run demo                 [--out dir] [--max n] [--no-video] [--fps n]
npm run build   -- <dir>                       # rebuild player.html from guide.json
npm run render  -- <dir> [--out file] [--fps n] [--width px]   # (re)render the MP4
npm run serve   -- <dir> [--port n]            # view player.html in a browser
```

Typical edit loop: `explore` → open the player → tweak → **Export guide.json**
into the guide folder → `npm run render -- <dir>` for the updated MP4.

## What it explores (and what it avoids)

The explorer classifies interactive elements (nav links, primary buttons,
search boxes, text inputs, selects, checkboxes) and walks the site to cover its
main pages, then demonstrates the interactions it finds — searching, ticking a
checkbox, filling and submitting a form. It stays on-site, ignores links that
open new tabs, and skips anything that looks destructive (log out, delete,
cancel, unsubscribe…).

## Requirements

- Node 18+
- A Chromium that Playwright can drive (the code auto-detects one under
  `PLAYWRIGHT_BROWSERS_PATH`; override with `GUIDEO_CHROMIUM=/path/to/chrome`).
- `ffmpeg` with libx264 for MP4 output (override with `GUIDEO_FFMPEG=/path/to/ffmpeg`).
  The HTML player and `guide.json` are produced without ffmpeg — only the MP4
  needs it.

## Project layout

```
src/
  cli.ts          command-line entry (explore / demo / build / render / serve)
  explore.ts      autonomous browser walkthrough → guide.json + screenshots
  captions.ts     beginner-friendly caption templates (offline, deterministic)
  build-player.ts bakes guide + assets into one self-contained player.html
  render.ts       replays the player frame-by-frame and encodes the MP4
  browser.ts      resolves the Chromium binary
  server.ts       tiny static server (demo site + viewing guides)
  player/         the front-end: template, styles, runtime, Tweak studio
  demo-site/      the bundled TaskFlow demo app
```
