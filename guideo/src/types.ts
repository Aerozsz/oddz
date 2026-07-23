/**
 * The Guide is the single source of truth. The explorer produces it, the Tweak
 * tab edits it, and both the HTML player and the MP4 renderer consume it. Every
 * position is normalized (0..1) against the capture viewport so a guide renders
 * identically at any output resolution.
 */

export type AnimationKind =
  | 'none'
  | 'fade'
  | 'kenburns-in'
  | 'kenburns-out'
  | 'pan-left'
  | 'pan-right';

export interface Cursor {
  /** Normalized 0..1 position of the pointer within the frame. */
  x: number;
  y: number;
  /** Whether a click ripple animates at this point. */
  click: boolean;
}

export interface Highlight {
  /** Normalized 0..1 spotlight box that dims everything outside it. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StepAction {
  type: 'navigate' | 'click' | 'type' | 'scroll' | 'observe';
  target?: string;
  value?: string;
}

export interface Step {
  id: string;
  title: string;
  /** Beginner-friendly narration shown as a caption. */
  caption: string;
  /** Screenshot: a relative path (on disk) or a data: URI (baked player). */
  image: string;
  durationMs: number;
  animation: AnimationKind;
  cursor: Cursor | null;
  /** Single highlight (legacy). Prefer `highlights`; kept for back-compat. */
  highlight: Highlight | null;
  /** Zero or more spotlight boxes, editable in the player. */
  highlights?: Highlight[];
  action: StepAction;
  /** Where to place the caption so it doesn't cover what's highlighted. */
  captionPos?: 'top' | 'bottom';
  /** Free caption placement (normalized x,y top-left + width), overrides captionPos. */
  captionBox?: { x: number; y: number; w: number } | null;
}

export interface Theme {
  accent: string;
  captionBg: string;
  captionColor: string;
  cursorColor: string;
  font: string;
}

export interface GuideMeta {
  title: string;
  description: string;
  site: string;
  sourceUrl: string;
  createdAt: string;
  /** Capture viewport, so aspect ratio survives round-trips. */
  viewport: { width: number; height: number };
}

export interface Guide {
  version: 1;
  meta: GuideMeta;
  theme: Theme;
  steps: Step[];
}

export const DEFAULT_THEME: Theme = {
  accent: '#6d5efc',
  captionBg: 'rgba(17,18,28,0.86)',
  captionColor: '#ffffff',
  cursorColor: '#ffffff',
  font: "'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};
