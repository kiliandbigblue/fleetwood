import { homedir } from 'node:os';
import { DEFAULT_THEME, THEMES, isThemeName, rgbTriplet } from '@fleetwood/core/theme';
import type { Palette } from '@fleetwood/core/theme';

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(open: string): (s: string) => string {
  return (s) => (useColor ? `\x1b[${open}m${s}\x1b[0m` : s);
}

/**
 * The palette in force, swapped by `useTheme` once the config has been read.
 *
 * Mutable, and read at paint time rather than captured when `c` is built:
 * `render.ts` assembles its status table at module load, before `main` has had a
 * chance to read anything off disk. Late-binding the lookup is what lets those
 * module-level references still honour the setting.
 */
let palette: Palette = THEMES[DEFAULT_THEME].palette;

/** Point `c` at a theme. An unknown name falls back rather than throwing. */
export function useTheme(name: unknown): void {
  palette = THEMES[isThemeName(name) ? name : DEFAULT_THEME].palette;
}

/**
 * The palette itself, for a caller that needs the values rather than a painter.
 *
 * `fw switch` is the one: fzf paints its own chrome — prompt, pointer, current
 * line, borders — and takes hex, so those have to be handed the same eleven
 * roles the rows are painted from or the popup comes out in fzf's default blue
 * inside a rosé-pine terminal.
 */
export function currentPalette(): Palette {
  return palette;
}

function role(name: keyof Palette): (s: string) => string {
  return (s) => (useColor ? `\x1b[38;2;${rgbTriplet(palette[name])}m${s}\x1b[0m` : s);
}

/**
 * The colours, named for their job — the same eleven roles the panel paints with,
 * minus the surfaces, which a terminal supplies itself.
 *
 * `dim` and `muted` are both here and are not the same thing: `dim` is SGR 2, the
 * terminal's own faint attribute, which stays legible whatever the theme; `muted`
 * is the palette's dimmest colour.
 */
export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  danger: role('danger'), // blocked / error
  warn: role('warn'), // waiting
  branch: role('branch'), // branch and repo names
  ok: role('ok'), // working
  accent: role('accent'), // the agent tool, and other accents
  muted: role('dim'),
};

/** Collapse $HOME to ~ so paths stay scannable. */
export function tildify(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function relativeAge(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function pad(s: string, to: number): string {
  const gap = to - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
