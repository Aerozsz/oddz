import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Guide } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_DIR = path.join(here, 'player');

/** Read a screenshot from disk and inline it as a data URI so the player is
 *  fully self-contained and shareable as a single file. */
async function toDataUri(guideDir: string, ref: string): Promise<string> {
  if (ref.startsWith('data:')) return ref;
  const abs = path.isAbsolute(ref) ? ref : path.join(guideDir, ref);
  const buf = await readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Bake a guide + assets into a single self-contained player.html. */
export async function buildPlayer(guideDir: string, guide?: Guide, outPath?: string): Promise<string> {
  const g: Guide = guide ?? JSON.parse(await readFile(path.join(guideDir, 'guide.json'), 'utf8'));

  const baked: Guide = {
    ...g,
    steps: await Promise.all(
      g.steps.map(async (s) => ({ ...s, image: await toDataUri(guideDir, s.image) }))
    ),
  };

  const [template, styles, runtime, tweak] = await Promise.all([
    readFile(path.join(PLAYER_DIR, 'template.html'), 'utf8'),
    readFile(path.join(PLAYER_DIR, 'styles.css'), 'utf8'),
    readFile(path.join(PLAYER_DIR, 'runtime.js'), 'utf8'),
    readFile(path.join(PLAYER_DIR, 'tweak.js'), 'utf8'),
  ]);

  // Guard the JSON against premature </script> parsing.
  const json = JSON.stringify(baked).split('</').join('<\\/');

  const html = template
    .split('__TITLE__').join(escapeHtml(g.meta.title))
    .split('/*__STYLES__*/').join(styles)
    .split('__GUIDE_JSON__').join(json)
    .split('/*__RUNTIME__*/').join(runtime)
    .split('/*__TWEAK__*/').join(tweak);

  const out = outPath ?? path.join(guideDir, 'player.html');
  await writeFile(out, html);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]!));
}
