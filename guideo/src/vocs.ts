/**
 * Emit a real Vocs project (the framework the Makina docs use), so the output
 * is a genuine, editable docs repo that builds on Vercel — not just static
 * HTML. Mirrors Makina's stack (vocs 2.x + vite + react) and their theme
 * (_root.css + teal accent) so the fork looks and builds like the original.
 *
 * One MDX page per section (see guide-sections.ts), branding assets and the
 * video in public/, and a generated sidebar in vocs.config.ts.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Guide, Step } from './types.js';
import { groupSteps } from './guide-sections.js';
import type { SiteFile } from './docsite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, 'docsite-assets');

function clean(s: string | undefined): string { return String(s || '').replace(/\s+/g, ' ').trim(); }
function pad(n: number): string { return String(n).padStart(2, '0'); }
/** Escape characters MDX would otherwise treat as JSX/markup/formatting. */
function mdx(s: string | undefined): string {
  return clean(s).replace(/([\\`*_{}\[\]<>])/g, '\\$1');
}
function stepHeading(step: Step, i: number): string {
  const t = clean(step.title);
  const m = /^.{2,60}?:\s*(\S.*)$/.exec(t);
  return (m ? m[1] : t) || 'Step ' + (i + 1);
}

interface DecodedImg { buf: Buffer; ext: string; }
function decodeImage(ref: string | undefined, guideDir?: string): DecodedImg | null {
  if (!ref) return null;
  if (ref.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(ref);
    if (!m) return null;
    let ext = m[1].toLowerCase(); if (ext === 'jpeg') ext = 'jpg'; if (ext === 'svg+xml') ext = 'svg';
    return { buf: Buffer.from(m[2], 'base64'), ext };
  }
  if (guideDir) {
    const abs = path.isAbsolute(ref) ? ref : path.join(guideDir, ref);
    if (existsSync(abs)) return { buf: readFileSync(abs), ext: (path.extname(abs).slice(1) || 'png').toLowerCase() };
  }
  return null;
}

export interface VocsInput {
  guide: Guide;
  guideDir?: string;
  mp4?: Buffer | null;
  /** Composited still per step (caption/highlights baked in); overrides raw screenshots. */
  stills?: (Buffer | null)[];
}

export function buildVocsProject(input: VocsInput): SiteFile[] {
  const { guide } = input;
  const meta = guide.meta || ({} as any);
  const title = clean(meta.title) || 'Guide';
  const files: SiteFile[] = [];
  const sections = groupSteps(guide);

  // ---- Branding + media in public/ ----
  const logoLight = existsSync(path.join(ASSETS, 'logo-light.svg')) ? readFileSync(path.join(ASSETS, 'logo-light.svg')) : null;
  const logoDark = existsSync(path.join(ASSETS, 'logo-dark.svg')) ? readFileSync(path.join(ASSETS, 'logo-dark.svg')) : null;
  const favicon = existsSync(path.join(ASSETS, 'favicon.ico')) ? readFileSync(path.join(ASSETS, 'favicon.ico')) : null;
  // Drop Makina-only external @imports (e.g. katex) we don't ship deps for.
  const rootCss = (existsSync(path.join(ASSETS, 'vocs-root.css')) ? readFileSync(path.join(ASSETS, 'vocs-root.css'), 'utf8') : '')
    .replace(/@import\s+["'][^"']*katex[^"']*["'];?[^\n]*\n?/gi, '');
  if (logoLight) files.push({ file: 'public/img/logo-light.svg', data: logoLight.toString('base64'), encoding: 'base64' });
  if (logoDark) files.push({ file: 'public/img/logo-dark.svg', data: logoDark.toString('base64'), encoding: 'base64' });
  if (favicon) files.push({ file: 'public/favicon.ico', data: favicon.toString('base64'), encoding: 'base64' });

  const imgNames: (string | null)[] = [];
  guide.steps.forEach((s, i) => {
    const still = input.stills && input.stills[i];
    if (still) {
      const name = 'guide-assets/step-' + pad(i + 1) + '.png';
      files.push({ file: 'public/' + name, data: still.toString('base64'), encoding: 'base64' });
      imgNames.push('/' + name);
      return;
    }
    const img = decodeImage(s.image, input.guideDir);
    if (img) {
      const name = 'guide-assets/step-' + pad(i + 1) + '.' + img.ext;
      files.push({ file: 'public/' + name, data: img.buf.toString('base64'), encoding: 'base64' });
      imgNames.push('/' + name);
    } else imgNames.push(null);
  });
  const hasVideo = !!input.mp4;
  if (input.mp4) files.push({ file: 'public/guide.mp4', data: input.mp4.toString('base64'), encoding: 'base64' });

  // ---- package.json (mirror Makina's stack) ----
  files.push({ file: 'package.json', data: JSON.stringify({
    name: (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'guide') + '-docs',
    version: '0.0.1', private: true, type: 'module',
    scripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', vite: '8.1.3', vocs: '2.5.3', waku: '1.0.0-beta.6' },
    devDependencies: { '@types/node': '^22.19.0', '@types/react': '^19.2.0', '@types/react-dom': '^19.2.0', '@vitejs/plugin-react': '^6.0.2', typescript: '^5.9.0' },
  }, null, 2) + '\n', encoding: 'utf-8' });

  // ---- vite.config.ts ----
  files.push({ file: 'vite.config.ts', data:
`import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { vocs } from "vocs/vite";

export default defineConfig({
  plugins: [react(), vocs()],
});
`, encoding: 'utf-8' });

  // ---- tsconfig.json ----
  files.push({ file: 'tsconfig.json', data: JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true,
      noEmit: true, resolveJsonModule: true, isolatedModules: true,
    },
    include: ['src', 'vocs.config.ts', 'vite.config.ts'],
  }, null, 2) + '\n', encoding: 'utf-8' });

  // ---- vocs.config.ts (sidebar + theme forked from Makina) ----
  const sidebar = [{ text: 'Overview', link: '/' } as any].concat(
    sections.map((s) => ({ text: s.title, link: '/' + s.slug }))
  );
  const topNav = meta.sourceUrl ? [{ text: 'Open the app', link: meta.sourceUrl }] : [];
  files.push({ file: 'vocs.config.ts', data:
`import { defineConfig } from "vocs/config";

// Theme + palette forked from the Makina docs (see src/pages/_root.css).
export default defineConfig({
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(clean(meta.description) || 'A step-by-step guide.')},
  titleTemplate: "%s | ${title.replace(/"/g, '')}",
  iconUrl: "/favicon.ico",
  logoUrl: { light: "/img/logo-light.svg", dark: "/img/logo-dark.svg" },
  accentColor: "light-dark(#0891b2, #3dc9de)",
  colorScheme: "light dark",
  topNav: ${JSON.stringify(topNav, null, 2)},
  sidebar: ${JSON.stringify(sidebar, null, 2)},
});
`, encoding: 'utf-8' });

  // ---- Theme CSS ----
  files.push({ file: 'src/pages/_root.css', data: rootCss || ':root{--vocs-color_accent: #0891b2;}', encoding: 'utf-8' });

  // ---- index.mdx (landing) ----
  const contentsList = sections.map((s, i) => '- [' + mdx(s.title) + '](/' + s.slug + ') — ' + s.steps.length + ' step' + (s.steps.length === 1 ? '' : 's')).join('\n');
  files.push({ file: 'src/pages/index.mdx', data:
`---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(clean(meta.description) || 'A step-by-step guide.')}
---

# ${mdx(title)}

${clean(meta.description) ? mdx(meta.description) + '\n' : ''}
${hasVideo ? '<video src="/guide.mp4" controls preload="metadata" playsInline style={{ width: "100%", borderRadius: "12px", border: "1px solid var(--vocs-border-color-primary)" }} />\n' : ''}
:::note
This guide is split into ${sections.length} section${sections.length === 1 ? '' : 's'}. Use the sidebar, or start below.
:::

## Contents

${contentsList}
`, encoding: 'utf-8' });

  // ---- One MDX page per section ----
  sections.forEach((sec) => {
    const body = sec.steps.map((st, k) => {
      const gi = sec.indices[k];
      const cap = clean(st.caption);
      return '## ' + mdx(stepHeading(st, gi)) + '\n\n' +
        (cap ? mdx(cap) + '\n\n' : '') +
        (imgNames[gi] ? '![' + mdx(stepHeading(st, gi).replace(/[\[\]]/g, '')) + '](' + imgNames[gi] + ')\n' : '');
    }).join('\n');
    files.push({ file: 'src/pages/' + sec.slug + '.mdx', data:
`---
title: ${JSON.stringify(sec.title)}
---

# ${mdx(sec.title)}

${body}`, encoding: 'utf-8' });
  });

  // ---- Project meta files ----
  files.push({ file: '.gitignore', data: 'node_modules/\ndist/\n.vocs/\n.DS_Store\n*.log\n', encoding: 'utf-8' });
  // No vercel.json on purpose: Vercel auto-detects Vocs and runs the correct
  // build/serve pipeline. A hand-forced static outputDirectory breaks it.
  files.push({ file: 'README.md', data:
`# ${title} — docs

A [Vocs](https://vocs.dev) documentation site generated by Guideo, themed after the Makina docs.

## Develop
\`\`\`bash
npm install
npm run dev
\`\`\`

## Build
\`\`\`bash
npm run build   # outputs static files to ./dist
\`\`\`

## Deploy to Vercel
This is a **Vocs 2 app** (server-rendered — it does not emit plain static
HTML). When importing at vercel.com/new, make sure Vercel runs the build:
set **Framework Preset = Vocs** (or Vite) and **Build Command = \`npm run build\`**.
Do **not** deploy the raw files without a build — you'll get a blank page.

\`\`\`bash
npx vercel deploy --prod   # from this folder, after 'npm install'
\`\`\`

### Want a zero-config static site instead?
If you just want a hosted docs site that deploys anywhere with no build step,
use Guideo's **"Deploy docs site to Vercel"** / **"Deployable site (.zip)"**
export instead — it's plain HTML with the same Makina look and needs no
framework detection.

_Content lives in \`src/pages/\`. Edit the MDX, add pages, and update \`vocs.config.ts\`'s sidebar as needed._
`, encoding: 'utf-8' });

  return files;
}
