/**
 * Turn a finished guide into shareable formats:
 *  - GitBook: a Markdown page + images, ready to drop into a GitBook space.
 *  - Social: an X (Twitter) thread and a Reddit post, with the step images.
 * Everything is bundled into a single .zip so it downloads as one file.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Guide, Step } from './types.js';
import { makeZip, type ZipEntry } from './zip.js';

export type ExportFormat = 'gitbook' | 'social';

interface DecodedImg { buf: Buffer; ext: string; }

function decodeImage(ref: string | undefined, guideDir?: string): DecodedImg | null {
  if (!ref) return null;
  if (ref.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(ref);
    if (!m) return null;
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    return { buf: Buffer.from(m[2], 'base64'), ext };
  }
  if (guideDir) {
    const abs = path.isAbsolute(ref) ? ref : path.join(guideDir, ref);
    if (existsSync(abs)) return { buf: readFileSync(abs), ext: (path.extname(abs).slice(1) || 'png').toLowerCase() };
  }
  return null;
}

function slug(s: string, fallback = 'guide'): string {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || fallback;
}
function pad(n: number): string { return String(n).padStart(2, '0'); }
function clean(s: string | undefined): string { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** Collect each step's image. Prefers a composited still (caption/highlights/
 *  dimming baked in) when provided; falls back to the raw screenshot. */
function stepImages(guide: Guide, guideDir?: string, stills?: (Buffer | null)[]): { entries: ZipEntry[]; names: (string | null)[] } {
  const entries: ZipEntry[] = [];
  const names: (string | null)[] = [];
  guide.steps.forEach((s: Step, i) => {
    const still = stills && stills[i];
    if (still) {
      const name = 'assets/step-' + pad(i + 1) + '.png';
      entries.push({ name, data: still });
      names.push(name);
      return;
    }
    const img = decodeImage(s.image, guideDir);
    if (img) {
      const name = 'assets/step-' + pad(i + 1) + '.' + img.ext;
      entries.push({ name, data: img.buf });
      names.push(name);
    } else {
      names.push(null);
    }
  });
  return { entries, names };
}

// ---------- GitBook ----------
function gitbookMarkdown(guide: Guide, imgNames: (string | null)[], hasVideo: boolean): string {
  const m = guide.meta || ({} as any);
  const L: string[] = [];
  L.push('# ' + (clean(m.title) || 'Guide'));
  L.push('');
  if (clean(m.description)) { L.push(clean(m.description)); L.push(''); }
  if (m.sourceUrl) { L.push('{% hint style="info" %}'); L.push('Walkthrough of [' + (clean(m.site) || m.sourceUrl) + '](' + m.sourceUrl + ').'); L.push('{% endhint %}'); L.push(''); }
  if (hasVideo) { L.push('> 📹 A video version (`guide.mp4`) is included in this bundle — upload it to your GitBook space and embed it here.'); L.push(''); }
  guide.steps.forEach((s, i) => {
    L.push('## ' + (i + 1) + '. ' + (clean(s.title) || 'Step ' + (i + 1)));
    L.push('');
    if (clean(s.caption)) { L.push(clean(s.caption)); L.push(''); }
    if (imgNames[i]) { L.push('![' + (clean(s.title) || 'Step ' + (i + 1)) + '](' + imgNames[i] + ')'); L.push(''); }
  });
  L.push('---');
  L.push('');
  L.push('_Generated with Guideo._');
  L.push('');
  return L.join('\n');
}

// ---------- Social ----------
function tweet(prefix: string, body: string, max = 278): string {
  const room = max - prefix.length;
  let b = clean(body);
  if (b.length > room) b = b.slice(0, Math.max(0, room - 1)).trimEnd() + '…';
  return prefix + b;
}

function xThread(guide: Guide, imgNames: (string | null)[], hasVideo: boolean): string {
  const m = guide.meta || ({} as any);
  const steps = guide.steps;
  const total = steps.length + 1;
  const L: string[] = [];
  L.push('# X / Twitter thread');
  L.push('');
  L.push('Copy each numbered block into a separate post. Attach the image noted under each one (the video, if any, goes on post 1).');
  L.push('');
  L.push('---');
  L.push('');
  // Opening post
  const openBody = clean(m.description) || ('A quick walkthrough of ' + (clean(m.site) || 'this app') + '.');
  L.push('**1/' + total + '**');
  L.push(tweet('', '🧵 ' + (clean(m.title) || 'How it works') + ' — ' + openBody));
  L.push(hasVideo ? '[attach: guide.mp4]' : (imgNames[0] ? '[attach: ' + imgNames[0] + ']' : ''));
  L.push('');
  steps.forEach((s, i) => {
    const n = i + 2;
    L.push('**' + n + '/' + total + '**');
    L.push(tweet('', (clean(s.title) ? clean(s.title) + ': ' : '') + clean(s.caption)));
    if (imgNames[i]) L.push('[attach: ' + imgNames[i] + ']');
    L.push('');
  });
  const tag = slug(m.site || m.title, '');
  L.push(tweet('', 'That’s the whole flow. ' + (tag ? '#' + tag.replace(/-/g, '') + ' ' : '') + '#howto #tutorial'));
  L.push('');
  return L.join('\n');
}

function redditPost(guide: Guide, imgNames: (string | null)[], hasVideo: boolean): string {
  const m = guide.meta || ({} as any);
  const L: string[] = [];
  L.push('# Reddit post');
  L.push('');
  L.push('**Suggested title:** ' + (clean(m.title) || 'A step-by-step walkthrough'));
  L.push('');
  L.push('**Body (Markdown — works in most subreddits; for image subs, post the `assets/` images as a gallery in this order):**');
  L.push('');
  L.push('---');
  L.push('');
  if (clean(m.description)) { L.push(clean(m.description)); L.push(''); }
  if (m.sourceUrl) { L.push('Site: ' + m.sourceUrl); L.push(''); }
  if (hasVideo) { L.push('Video: attach `guide.mp4` (or link it).'); L.push(''); }
  guide.steps.forEach((s, i) => {
    L.push('**' + (i + 1) + '. ' + (clean(s.title) || 'Step ' + (i + 1)) + '**');
    if (clean(s.caption)) L.push('');
    if (clean(s.caption)) L.push(clean(s.caption));
    if (imgNames[i]) L.push('');
    if (imgNames[i]) L.push('*(image: ' + imgNames[i] + ')*');
    L.push('');
  });
  L.push('---');
  L.push('');
  L.push('_Generated with Guideo._');
  L.push('');
  return L.join('\n');
}

export interface ExportInput {
  guide: Guide;
  /** For guides on disk whose images are file paths (not data URIs). */
  guideDir?: string;
  /** The rendered MP4, to include in the bundle (optional). */
  mp4?: Buffer | null;
  /** Composited still per step (caption/highlights baked in); overrides raw screenshots. */
  stills?: (Buffer | null)[];
}

export interface ExportResult {
  zip: Buffer;
  filename: string;
}

export function buildExport(format: ExportFormat, input: ExportInput): ExportResult {
  const { guide } = input;
  const { entries: imgEntries, names } = stepImages(guide, input.guideDir, input.stills);
  const hasVideo = !!input.mp4;
  const base = slug(guide.meta && guide.meta.title);
  const files: ZipEntry[] = [...imgEntries];
  if (input.mp4) files.push({ name: 'guide.mp4', data: input.mp4 });

  if (format === 'gitbook') {
    files.unshift({ name: 'README.md', data: Buffer.from(gitbookMarkdown(guide, names, hasVideo), 'utf8') });
    return { zip: makeZip(files), filename: base + '-gitbook.zip' };
  }
  // social
  files.unshift({ name: 'x-thread.md', data: Buffer.from(xThread(guide, names, hasVideo), 'utf8') });
  files.push({ name: 'reddit-post.md', data: Buffer.from(redditPost(guide, names, hasVideo), 'utf8') });
  files.push({
    name: 'README.txt',
    data: Buffer.from(
      'Guideo social export\n\n' +
      '- x-thread.md   : paste each numbered block as its own post; attach the image named under it.\n' +
      '- reddit-post.md: a ready title + Markdown body; post assets/ as a gallery for image subs.\n' +
      '- assets/       : the step screenshots, in order.\n' +
      (hasVideo ? '- guide.mp4     : the video (X accepts up to 2:20; Reddit accepts mp4).\n' : ''),
      'utf8'
    ),
  });
  return { zip: makeZip(files), filename: base + '-social.zip' };
}
