/**
 * The colour themes, and the eleven roles every one of them fills.
 *
 * Both surfaces paint from here — the panel writes these into CSS custom
 * properties, the CLI into truecolor escapes — so `fw` and the app cannot end up
 * disagreeing about what "blocked" looks like.
 *
 * The values are the upstream palettes exactly as their neovim plugins define
 * them (`rose-pine/palette.lua`, `catppuccin/palettes/*.lua`,
 * `tokyonight/colors/*.lua`), not approximations. That is the whole point of the
 * feature: a panel that sits beside the editor all day has to be the same
 * colours as the editor, and a hand-mixed near-miss is precisely what reads as
 * wrong. Ghostty's theme files were the other candidate source and are not
 * enough — they carry sixteen ANSI slots plus a background, with nothing for the
 * layered surfaces a card needs.
 *
 * What *is* a judgement call is the mapping: which of a palette's greys is
 * `edge`, which of its accents is `ok`. Each family's block below says how it was
 * read.
 */

/**
 * One colour per job, named for the job.
 *
 * Deliberately not named for Rose Pine's flowers, which is what this used to be:
 * `--love` is a fine name for a colour until the active theme is Catppuccin and
 * the value is Catppuccin's red, at which point the name is just untrue.
 */
export interface Palette {
  /** The window itself: header, scroll body, input and textarea fills. */
  bg: string;
  /** Raised over `bg` — cards, modals, the theme popover. */
  panel: string;
  /** The line between a panel and what sits on it: borders, pills, hover fills. */
  edge: string;
  /** The dimmest text still meant to be read: paths, counts, `idle`, timings. */
  dim: string;
  /** Secondary text: an agent's activity line, a task's notes, prompt options. */
  soft: string;
  /** Primary text. */
  text: string;
  /** Blocked, error, off-branch, and every destructive action. */
  danger: string;
  /** Waiting on you: `blocked_input`, a dirty worktree, a build still running. */
  warn: string;
  /** Working, checks passing, approved, deployed. */
  ok: string;
  /** Accents: the agent tool, selection, links, "to deploy". */
  accent: string;
  /** Branch and repo names — neither a status nor an accent, so its own role. */
  branch: string;
}

export interface Theme {
  /** The flavour, shown as the row in the picker. */
  label: string;
  /** The family, so the picker can group flavours under one heading. */
  family: string;
  palette: Palette;
}

export type ThemeName =
  | 'rose-pine'
  | 'rose-pine-moon'
  | 'catppuccin-mocha'
  | 'catppuccin-macchiato'
  | 'catppuccin-frappe'
  | 'tokyonight-night'
  | 'tokyonight-storm'
  | 'tokyonight-moon';

/**
 * Rose Pine ships `base < surface < overlay` as its three backgrounds and names
 * its accents directly, so it maps onto the roles one-for-one — unsurprisingly,
 * since these roles were extracted from the hardcoded Rose Pine the panel had
 * before this file existed. `leaf`, `pine` and the `highlight_*` triple are
 * unused: nothing in either UI needs a fourth surface or a second green.
 */
const ROSE_PINE: Record<'rose-pine' | 'rose-pine-moon', Theme> = {
  'rose-pine': {
    label: 'Main',
    family: 'Rosé Pine',
    palette: {
      bg: '#191724',
      panel: '#1f1d2e',
      edge: '#26233a',
      dim: '#6e6a86',
      soft: '#908caa',
      text: '#e0def4',
      danger: '#eb6f92', // love
      warn: '#f6c177', // gold
      ok: '#9ccfd8', // foam
      accent: '#c4a7e7', // iris
      branch: '#ebbcba', // rose
    },
  },
  'rose-pine-moon': {
    label: 'Moon',
    family: 'Rosé Pine',
    palette: {
      bg: '#232136',
      panel: '#2a273f',
      edge: '#393552',
      dim: '#6e6a86',
      soft: '#908caa',
      text: '#e0def4',
      danger: '#eb6f92',
      warn: '#f6c177',
      ok: '#9ccfd8',
      accent: '#c4a7e7',
      branch: '#ea9a97',
    },
  },
};

/**
 * Catppuccin stacks `crust < mantle < base < surface0 < surface1 < surface2`, and
 * its own style guide reserves `base` for the primary background and the
 * `surface*` run for elements raised above it — which is exactly the
 * window/card/border ladder here, so `bg → base`, `panel → surface0`,
 * `edge → surface1`. The darker `mantle` and `crust` go unused: fleetwood's cards
 * sit *above* the window, and using them would invert that.
 *
 * For text, `subtext0` is the guide's secondary text and the `overlay*` run its
 * comments and muted glyphs, giving `soft → subtext0`, `dim → overlay1`.
 *
 * The accents are the obvious reading except `branch`, which wants Rose Pine's
 * soft pinkish `rose`: `flamingo` is the closest in both hue and lightness, and
 * unlike `peach` it cannot be mistaken for `red` at the 10.5px a branch name is
 * set in.
 */
const CATPPUCCIN: Record<'catppuccin-mocha' | 'catppuccin-macchiato' | 'catppuccin-frappe', Theme> =
  {
    'catppuccin-mocha': {
      label: 'Mocha',
      family: 'Catppuccin',
      palette: {
        bg: '#1e1e2e', // base
        panel: '#313244', // surface0
        edge: '#45475a', // surface1
        dim: '#7f849c', // overlay1
        soft: '#a6adc8', // subtext0
        text: '#cdd6f4',
        danger: '#f38ba8', // red
        warn: '#f9e2af', // yellow
        ok: '#94e2d5', // teal
        accent: '#cba6f7', // mauve
        branch: '#f2cdcd', // flamingo
      },
    },
    'catppuccin-macchiato': {
      label: 'Macchiato',
      family: 'Catppuccin',
      palette: {
        bg: '#24273a',
        panel: '#363a4f',
        edge: '#494d64',
        dim: '#8087a2',
        soft: '#a5adcb',
        text: '#cad3f5',
        danger: '#ed8796',
        warn: '#eed49f',
        ok: '#8bd5ca',
        accent: '#c6a0f6',
        branch: '#f0c6c6',
      },
    },
    'catppuccin-frappe': {
      label: 'Frappé',
      family: 'Catppuccin',
      palette: {
        bg: '#303446',
        panel: '#414559',
        edge: '#51576d',
        dim: '#838ba7',
        soft: '#a5adce',
        text: '#c6d0f5',
        danger: '#e78284',
        warn: '#e5c890',
        ok: '#81c8be',
        accent: '#ca9ee6',
        branch: '#eebebe',
      },
    },
  };

/**
 * Tokyo Night names two backgrounds rather than three: `bg` for the editor and
 * `bg_dark` for the sidebar, statusline and popups. The panel wants the window to
 * recede behind the cards, so `bg → bg_dark`, `panel → bg`.
 *
 * For `edge` that leaves `bg_highlight` (the cursorline) or `fg_gutter`.
 * `fg_gutter` is the one the theme itself uses for separators and float borders,
 * and it is the only one of the two light enough for a 1px card border to
 * actually be visible — `bg_highlight` disappears against `bg`.
 *
 * `comment` and `fg_dark` are the theme's own two tiers of subdued text, so they
 * take `dim` and `soft` directly. `branch` goes to `orange`: the family has no
 * rosewater, and `orange` is the one warm accent that is neither `red` nor the
 * `magenta` already spent on `accent`.
 */
const TOKYO_NIGHT: Record<'tokyonight-night' | 'tokyonight-storm' | 'tokyonight-moon', Theme> = {
  'tokyonight-night': {
    label: 'Night',
    family: 'Tokyo Night',
    palette: {
      bg: '#16161e', // bg_dark
      panel: '#1a1b26', // bg
      edge: '#3b4261', // fg_gutter
      dim: '#565f89', // comment
      soft: '#a9b1d6', // fg_dark
      text: '#c0caf5', // fg
      danger: '#f7768e', // red
      warn: '#e0af68', // yellow
      ok: '#7dcfff', // cyan
      accent: '#bb9af7', // magenta
      branch: '#ff9e64', // orange
    },
  },
  'tokyonight-storm': {
    label: 'Storm',
    family: 'Tokyo Night',
    palette: {
      bg: '#1f2335',
      panel: '#24283b',
      edge: '#3b4261',
      dim: '#565f89',
      soft: '#a9b1d6',
      text: '#c0caf5',
      danger: '#f7768e',
      warn: '#e0af68',
      ok: '#7dcfff',
      accent: '#bb9af7',
      branch: '#ff9e64',
    },
  },
  'tokyonight-moon': {
    label: 'Moon',
    family: 'Tokyo Night',
    palette: {
      bg: '#1e2030',
      panel: '#222436',
      edge: '#3b4261',
      dim: '#636da6',
      soft: '#828bb8',
      text: '#c8d3f5',
      danger: '#ff757f',
      warn: '#ffc777',
      ok: '#86e1fc',
      accent: '#c099ff',
      branch: '#ff966c',
    },
  },
};

export const THEMES: Record<ThemeName, Theme> = { ...ROSE_PINE, ...CATPPUCCIN, ...TOKYO_NIGHT };

/**
 * Rose Pine, because the tmux status line beside this panel is Rose Pine.
 *
 * Not a neutral choice so much as the honest one: it is what the panel was
 * hardcoded to before it could be switched, so an existing install that never
 * sets `theme` keeps the colours it already had.
 */
export const DEFAULT_THEME: ThemeName = 'rose-pine';

/** In the order the picker should list them — families together, darkest first. */
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && value in THEMES;
}

/** The palette to paint with, for a name that may have been typed by hand. */
export function paletteFor(name: unknown): Palette {
  return THEMES[isThemeName(name) ? name : DEFAULT_THEME].palette;
}

/**
 * `#rrggbb` → `r;g;b`, for the CLI's `\x1b[38;2;…m`.
 *
 * Lives here rather than in the CLI because it is the one place that knows what
 * shape a palette value is, and the assertion belongs beside the data it guards.
 */
export function rgbTriplet(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const value = Number.parseInt(match[1] as string, 16);
  return `${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}
