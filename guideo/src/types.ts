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
  /** Show only between these fractions of the step (0..1). Defaults to 0 / 1. */
  t0?: number;
  t1?: number;
}

export interface StepAction {
  type: 'navigate' | 'click' | 'type' | 'scroll' | 'observe';
  target?: string;
  value?: string;
}

export interface TextLabel {
  /** Normalized 0..1 top-left position. */
  x: number;
  y: number;
  text: string;
  /** Optional bold lead shown before the text (like a caption title). */
  title?: string;
  /** Font size as a fraction of frame height (e.g. 0.045). */
  size?: number;
  color?: string;
  /** Font family override for this label. */
  font?: string;
  /** Draw a rounded background behind the text. */
  bg?: boolean;
  /** Show only between these fractions of the step (0..1). Defaults to 0 / 1. */
  t0?: number;
  t1?: number;
}

export interface Step {
  id: string;
  title: string;
  /** Beginner-friendly narration shown as a caption. */
  caption: string;
  /** Screenshot: a relative path (on disk) or a data: URI (baked player). */
  image: string;
  /** Optional video (data URI) shown instead of the image, synced to the step. */
  video?: string;
  /** Optional animated GIF (data URI) shown instead of the image. */
  gif?: string;
  durationMs: number;
  animation: AnimationKind;
  cursor: Cursor | null;
  /** Single highlight (legacy). Prefer `highlights`; kept for back-compat. */
  highlight: Highlight | null;
  /** Zero or more spotlight boxes, editable in the player. */
  highlights?: Highlight[];
  /** Text annotations stamped on the frame (e.g. a number over a chart). */
  labels?: TextLabel[];
  action: StepAction;
  /** Where to place the caption so it doesn't cover what's highlighted. */
  captionPos?: 'top' | 'bottom';
  /** Free caption placement (normalized x,y top-left + width), overrides captionPos. */
  captionBox?: { x: number; y: number; w: number } | null;
  /** Show the caption only between these fractions of the step (0..1). */
  captionT0?: number;
  captionT1?: number;
  /** Darkness of the spotlight dim for this step (0..1). Defaults to theme.dim. */
  dimIntensity?: number;
  /** Per-step style overrides (fall back to the guide theme). */
  font?: string;
  accent?: string;
  captionColor?: string;
  captionBg?: string;
}

export interface Theme {
  accent: string;
  captionBg: string;
  captionColor: string;
  cursorColor: string;
  font: string;
  /** Default spotlight dim darkness (0..1). */
  dim?: number;
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
