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

/**
 * Code points a terminal draws two cells wide, as ranges.
 *
 * Not the whole of UAX#11 — the practical table: the CJK and Hangul blocks, the
 * emoji planes, and the scattered singletons in the symbol blocks that have
 * Emoji_Presentation and so default to the wide glyph. `✋` (U+270B) is one of
 * those and `✗` (U+2717) is not, which is exactly why the block cannot be
 * painted with one brush.
 */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

/**
 * Marks that take no cell of their own: combining accents, the variation
 * selectors that ask for the emoji glyph, and the zero-width joiner. A
 * `✋` followed by U+FE0F is still two cells, not three.
 */
function isZeroWidth(code: number): boolean {
  if (code === 0x200d) return true;
  if (code >= 0x0300 && code <= 0x036f) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  return code >= 0xe0100 && code <= 0xe01ef;
}

/** How many cells one code point occupies. */
export function charWidth(code: number): number {
  if (isZeroWidth(code)) return 0;
  for (const [lo, hi] of WIDE) {
    if (code < lo) break;
    if (code <= hi) return 2;
  }
  return 1;
}

/**
 * Visible width in terminal cells, ignoring ANSI escapes.
 *
 * Cells, not characters. `'✋'.length` is 1 and the terminal gives it two
 * columns, so counting code units under-measured every row carrying one — which
 * is one bug with three faces: the `✋` gutter pushed its name a column right of
 * every other name, a `✋ permission` chip ran a column wider than `○ idle`, and
 * so the columns after them in those rows never lined up with the rest. Every
 * padded column in both the fleet list and the picker is measured through here,
 * so the fix lands in all of them at once.
 */
export function width(s: string): number {
  let total = 0;
  for (const char of s.replace(/\x1b\[[0-9;]*m/g, '')) {
    total += charWidth(char.codePointAt(0) ?? 0);
  }
  return total;
}

/**
 * Cut to `n` cells, by code point.
 *
 * Slicing by index splits a surrogate pair — an agent names its own session and
 * an emoji in that title would leave half a character and a broken cell — and a
 * wide glyph has to count for the two columns it takes or the clip overruns.
 */
export function clipWidth(s: string, n: number): string {
  if (width(s) <= n) return s;
  let out = '';
  let used = 0;
  for (const char of s) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (used + w > n - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function pad(s: string, to: number): string {
  const gap = to - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
