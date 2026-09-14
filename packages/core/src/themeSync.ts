/**
 * Push the chosen theme out to the other surfaces on the desk: Ghostty, Neovim
 * and tmux.
 *
 * The panel's picker used to colour the panel and nothing else, which left the
 * one setting that exists to stop the window clashing with the terminal beside
 * it doing exactly half the job. Everything here is what
 * `~/.agents/skills/switch-theme` did as a shell-out, moved in so the click is
 * the whole gesture.
 *
 * Two things are deliberately different from that script:
 *
 * 1. Nothing here holds a second copy of the colours. The tmux status palette
 *    and the generated Ghostty themes are computed from `theme.ts`, which is
 *    already the file both front ends paint from — so a palette tweak lands on
 *    all four surfaces at once and they cannot drift. (The one visible change
 *    from the script: Rosé Pine Main's `ST_PINE` was the palette's darker
 *    `pine`, and is now `ok` like every other flavour's.)
 * 2. Every path is a config key, because this writes to files outside
 *    `~/.fleetwood` — a machine laid out differently must be able to say so, or
 *    switch it off.
 *
 * A missing file is skipped, never fatal. Picking a colour must not fail
 * because a dotfile moved, and the panel repaints from `config.json` regardless
 * of how any of this goes.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.ts';
import { BACKUP_DIR } from './paths.ts';
import { THEMES } from './theme.ts';
import type { Palette, ThemeName } from './theme.ts';

/**
 * Where the other three surfaces keep their configuration.
 *
 * Ghostty appears twice on purpose: on macOS the file under Application Support
 * is the one it actually reads, and it overrides the dotfiles copy — which is
 * kept in sync anyway so the two do not drift further than they already have.
 */
export interface ThemeSyncConfig {
  /** Off means the picker colours the panel only, as it did before. */
  enabled: boolean;
  /** The effective Ghostty config on macOS. */
  ghosttyConfig: string;
  /** Where Ghostty looks for themes that aren't built in. */
  ghosttyThemeDir: string;
  /** The checked-in Ghostty config, kept in step with the live one. */
  ghosttyDotfileConfig: string;
  /** The checked-in copy of the generated themes, for the same reason. */
  ghosttyDotfileThemeDir: string;
  /** The lua file holding the `vim.cmd.colorscheme(…)` call. */
  nvimColorscheme: string;
  tmuxConf: string;
  /**
   * Whether to `source-file` the rewritten tmux.conf.
   *
   * The one surface that can be reloaded without touching the thing you are
   * looking at — the panel already drives tmux all day, so this is one more
   * cheap invocation rather than a new kind of liberty. Ghostty and Neovim are
   * reported instead: reloading them means either a keystroke into the frontmost
   * window or typing into somebody's editor.
   */
  reloadTmux: boolean;
}

export const DEFAULT_THEME_SYNC: ThemeSyncConfig = {
  enabled: true,
  ghosttyConfig: join(homedir(), 'Library/Application Support/com.mitchellh.ghostty/config'),
  ghosttyThemeDir: join(homedir(), 'Library/Application Support/com.mitchellh.ghostty/themes'),
  ghosttyDotfileConfig: join(homedir(), 'dotfiles/.config/ghostty/config'),
  ghosttyDotfileThemeDir: join(homedir(), 'dotfiles/.config/ghostty/themes'),
  nvimColorscheme: join(homedir(), 'dotfiles/.config/nvim/lua/kiliand/plugins/colorscheme.lua'),
  tmuxConf: join(homedir(), 'dotfiles/.tmux.conf'),
  reloadTmux: true,
};

/** The tmux theme plugins the config can have exactly one of loaded. */
type TmuxFamily = 'rose-pine' | 'catppuccin' | 'tokyonight' | 'helldivers';

interface External {
  /** Ghostty's name for it — a built-in, unless `generated`. */
  ghostty: string;
  /** True when no Ghostty built-in exists and the theme file is written here. */
  generated?: true;
  /** The `colorscheme` name, as the Neovim plugin registers it. */
  nvim: string;
  tmux: { family: TmuxFamily; variant?: string };
}

/**
 * Each theme's name on the other three surfaces.
 *
 * Kept out of `theme.ts` so that file stays what it says it is — eleven roles
 * and the palettes filling them, importable by a renderer that has no
 * filesystem. Typed as a full `Record<ThemeName, …>`, so adding a flavour there
 * fails to compile until it has been named here too.
 */
const EXTERNAL: Record<ThemeName, External> = {
  'rose-pine': {
    ghostty: 'Rose Pine',
    nvim: 'rose-pine',
    tmux: { family: 'rose-pine', variant: 'main' },
  },
  'rose-pine-moon': {
    ghostty: 'Rose Pine Moon',
    nvim: 'rose-pine-moon',
    tmux: { family: 'rose-pine', variant: 'moon' },
  },
  'catppuccin-mocha': {
    ghostty: 'Catppuccin Mocha',
    nvim: 'catppuccin-mocha',
    tmux: { family: 'catppuccin', variant: 'mocha' },
  },
  'catppuccin-macchiato': {
    ghostty: 'Catppuccin Macchiato',
    nvim: 'catppuccin-macchiato',
    tmux: { family: 'catppuccin', variant: 'macchiato' },
  },
  'catppuccin-frappe': {
    ghostty: 'Catppuccin Frappe',
    nvim: 'catppuccin-frappe',
    tmux: { family: 'catppuccin', variant: 'frappe' },
  },
  // `tokyo-night-tmux` has one fixed palette, so all three flavours give the
  // same status bar — there is no variant option to set.
  'tokyonight-night': {
    ghostty: 'TokyoNight Night',
    nvim: 'tokyonight-night',
    tmux: { family: 'tokyonight' },
  },
  'tokyonight-storm': {
    ghostty: 'TokyoNight Storm',
    nvim: 'tokyonight-storm',
    tmux: { family: 'tokyonight' },
  },
  'tokyonight-moon': {
    ghostty: 'TokyoNight Moon',
    nvim: 'tokyonight-moon',
    tmux: { family: 'tokyonight' },
  },
  // Fleetwood's own flavours: no Ghostty built-in and no tmux plugin, so the
  // theme file is generated below and tmux falls through to the hand-rolled
  // status line, which is painted from the palette either way.
  'helldivers-terminids': {
    ghostty: 'helldivers-terminids',
    generated: true,
    nvim: 'helldivers-terminids',
    tmux: { family: 'helldivers' },
  },
  'helldivers-automatons': {
    ghostty: 'helldivers-automatons',
    generated: true,
    nvim: 'helldivers-automatons',
    tmux: { family: 'helldivers' },
  },
  'helldivers-illuminate': {
    ghostty: 'helldivers-illuminate',
    generated: true,
    nvim: 'helldivers-illuminate',
    tmux: { family: 'helldivers' },
  },
};

export type Surface = 'ghostty' | 'nvim' | 'tmux';

export interface SurfaceResult {
  surface: Surface;
  /** One line per file, in the shape `~/path: what happened`. */
  notes: string[];
  /** True when something was actually rewritten, not merely already correct. */
  changed: boolean;
  /** What the user has to do for it to show, when we cannot do it ourselves. */
  reload?: string;
  /** Set when the surface could not be written at all. */
  error?: string;
}

export interface ThemeSyncReport {
  theme: ThemeName;
  surfaces: SurfaceResult[];
  /** Set instead of `surfaces` when `themeSync.enabled` is false. */
  skipped?: string;
}

// ── file plumbing ─────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Timestamped copy before any edit. Never overwrites a previous backup.
 *
 * The same arrangement as `hookInstall.ts`, and for a stronger reason: these are
 * hand-written config files with a decade of comments in them, and the rewrites
 * below are regex-driven.
 *
 * Unlike `hookInstall.ts` the name needs a tiebreak, because two of the files
 * here are both called `config` — Ghostty's live one and the checked-in one —
 * and one sync writes them inside the same millisecond, so a bare timestamp
 * would let the second copy silently eat the first.
 */
async function backup(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(BACKUP_DIR, `${path.split('/').pop() ?? 'config'}.${stamp}`);
  let target = base;
  for (let n = 1; await exists(target); n++) target = `${base}.${n}`;
  await copyFile(path, target);
}

/** Write via a sibling temp file, so a crash mid-write cannot truncate a config. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.fleetwood.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

class Notes {
  readonly lines: string[] = [];
  changed = false;

  note(path: string, what: string): void {
    this.lines.push(`${tildify(path)}: ${what}`);
  }
}

/**
 * Rewrite a file in place, reporting whether the substitution actually matched.
 *
 * A pattern that matches nothing is a warning rather than an error: these are
 * the user's own files, and the honest answer to "your tmux.conf no longer has a
 * status palette block" is to say so and leave the file alone.
 */
async function editFile(
  path: string,
  notes: Notes,
  edit: (text: string) => { text: string; note: string },
): Promise<void> {
  if (!(await exists(path))) {
    notes.note(path, 'missing — skipped');
    return;
  }
  const before = await readFile(path, 'utf8');
  const { text, note } = edit(before);
  if (text === before) {
    notes.note(path, note);
    return;
  }
  await backup(path);
  await writeAtomic(path, text);
  notes.changed = true;
  notes.note(path, note);
}

// ── ghostty ───────────────────────────────────────────────────────────

const GHOSTTY_THEME_LINE = /^([ \t]*)theme\s*=.*$/m;

/**
 * A Ghostty theme file, derived from the palette.
 *
 * Only used for the flavours Ghostty has no built-in for. The upstream families
 * keep their own theme files: those carry sixteen ANSI slots chosen by the people
 * who designed the palette, and a mapping invented here would be a worse
 * Catppuccin than Catppuccin's.
 *
 * The mapping below is the reverse of how these flavours were drawn in the first
 * place — `edge` as the black slot so a terminal's "bright background" is the
 * panel's border colour, `branch` doing double duty as blue and cyan because the
 * palette has one cool accent, and no bold/bright variants because the palette
 * holds one value per role by design.
 */
export function ghosttyTheme(palette: Palette): string {
  const slots = [
    palette.edge,
    palette.danger,
    palette.ok,
    palette.warn,
    palette.branch,
    palette.accent,
    palette.branch,
    palette.text,
    palette.dim,
    palette.danger,
    palette.ok,
    palette.warn,
    palette.branch,
    palette.accent,
    palette.soft,
    palette.text,
  ];
  return `${[
    ...slots.map((hex, index) => `palette = ${index}=${hex}`),
    `background = ${palette.bg}`,
    `foreground = ${palette.text}`,
    `cursor-color = ${palette.text}`,
    `cursor-text = ${palette.bg}`,
    `selection-background = ${palette.edge}`,
    `selection-foreground = ${palette.text}`,
  ].join('\n')}\n`;
}

/** Write the generated theme where Ghostty reads it, and into the checkout. */
async function writeGhosttyTheme(
  name: string,
  palette: Palette,
  dirs: string[],
  notes: Notes,
): Promise<void> {
  const text = ghosttyTheme(palette);
  for (const dir of dirs) {
    const path = join(dir, name);
    // The live directory may not exist yet on an install that has never used a
    // custom theme; the dotfiles one we only fill if it is already there, since
    // creating directories inside somebody's checkout is not our business.
    if (dir === dirs[0]) await mkdir(dir, { recursive: true });
    else if (!(await exists(dir))) {
      notes.note(dir, 'missing — skipped');
      continue;
    }
    if ((await exists(path)) && (await readFile(path, 'utf8')) === text) {
      notes.note(path, 'already generated');
      continue;
    }
    await writeAtomic(path, text);
    notes.changed = true;
    notes.note(path, 'theme file generated from the palette');
  }
}

async function syncGhostty(
  theme: ThemeName,
  config: ThemeSyncConfig,
  notes: Notes,
): Promise<void> {
  const { ghostty, generated } = EXTERNAL[theme];
  if (generated) {
    await writeGhosttyTheme(
      ghostty,
      THEMES[theme].palette,
      [config.ghosttyThemeDir, config.ghosttyDotfileThemeDir],
      notes,
    );
  }
  for (const path of [config.ghosttyConfig, config.ghosttyDotfileConfig]) {
    // Only the `theme` line: the two files have genuinely diverged on font-size
    // and background-opacity, and syncing those would be picking a winner.
    await editFile(path, notes, (text) => ({
      text: text.replace(GHOSTTY_THEME_LINE, (_, indent: string) => `${indent}theme = ${ghostty}`),
      note: GHOSTTY_THEME_LINE.test(text)
        ? `theme = ${ghostty}`
        : 'no `theme =` line found — left untouched',
    }));
  }
}

// ── neovim ────────────────────────────────────────────────────────────

const NVIM_COLORSCHEME_LINE = /^([ \t]*)vim\.cmd\.colorscheme\(".*?"\)(.*)$/m;

async function syncNvim(theme: ThemeName, config: ThemeSyncConfig, notes: Notes): Promise<void> {
  const { nvim } = EXTERNAL[theme];
  // The explicit `colorscheme` call wins over the `style` field in each plugin's
  // own `setup()`, so those are deliberately left alone — a tokyonight `setup`
  // saying `style = "moon"` does nothing once Night is the colorscheme.
  await editFile(config.nvimColorscheme, notes, (text) => ({
    text: text.replace(
      NVIM_COLORSCHEME_LINE,
      (_, indent: string, rest: string) => `${indent}vim.cmd.colorscheme("${nvim}")${rest}`,
    ),
    note: NVIM_COLORSCHEME_LINE.test(text)
      ? `colorscheme("${nvim}")`
      : 'no `vim.cmd.colorscheme(…)` line found — left untouched',
  }));
}

// ── tmux ──────────────────────────────────────────────────────────────

/**
 * tmux.conf lines that belong to exactly one theme family.
 *
 * The comment-stripped content is matched verbatim, which is what makes the
 * toggle idempotent and keeps it from touching a line that is not part of a
 * theme block. Everything the config has commented out for other reasons — a
 * plugin being tried, a binding retired — is invisible to this table and stays
 * exactly as written.
 */
const TMUX_OWNED_LINES: Record<string, TmuxFamily> = {
  'set -g @plugin "janoamaral/tokyo-night-tmux"': 'tokyonight',
  'set -g @tokyo-night-tmux_window_id_style hsquare': 'tokyonight',
  'set -g @tokyo-night-tmux_pane_id_style hide': 'tokyonight',
  'set -g @tokyo-night-tmux_zoom_id_style dsquare': 'tokyonight',
  'set -g @tokyo-night-tmux_transparent 1': 'tokyonight',
  'set -g @tokyo-night-tmux_show_datetime 0': 'tokyonight',
  'set -g @tokyo-night-tmux_show_git 0': 'tokyonight',
  'set -g @tokyo-night-tmux_show_wbg 0': 'tokyonight',
  'set -g @tokyo-night-tmux_show_music 0': 'tokyonight',
  "set -g @plugin 'rose-pine/tmux'": 'rose-pine',
  'run-shell ~/.tmux/plugins/rose-pine-tmux/rose-pine.tmux': 'rose-pine',
  'run ~/.config/tmux/plugins/catppuccin/tmux/catppuccin.tmux': 'catppuccin',
  'set -g status-right-length 100': 'catppuccin',
  'set -g status-left-length 100': 'catppuccin',
  'set -g status-left ""': 'catppuccin',
  'set -g status-right "#{E:@catppuccin_status_application}"': 'catppuccin',
};

/** Variant lines carry a value, so the family that owns one also rewrites it. */
const TMUX_VARIANT_LINES: Partial<
  Record<TmuxFamily, { match: RegExp; line: (variant: string) => string }>
> = {
  'rose-pine': {
    match: /^set -g @rose_pine_variant\s+'.*'$/,
    line: (variant) => `set -g @rose_pine_variant '${variant}'`,
  },
  catppuccin: {
    match: /^set -g @catppuccin_flavor\s+'.*'$/,
    line: (variant) => `set -g @catppuccin_flavor '${variant}'`,
  },
};

/** `  # # set -g …` → indent, hashes, content. */
const TMUX_COMMENT = /^([ \t]*)((?:#[ \t]?)*)(.*)$/;

const STATUS_PALETTE_BLOCK =
  /# -- status-palette \(managed by (?:switch-theme|fleetwood)\) --\n[\s\S]*?\n# -- end status-palette --/;

/**
 * The `ST_*` block the hand-rolled status line paints from.
 *
 * The marker still says `switch-theme`, which is no longer the only thing that
 * writes it — but that skill's script matches the marker verbatim to find the
 * block, and renaming it would leave the script reporting that a config it can
 * still perfectly well rewrite has no palette in it. The regex below accepts
 * either name, so a hand-renamed block keeps working too.
 *
 * Named for Rosé Pine's flowers because that is what the status line's own
 * format strings say, and renaming them would mean rewriting forty lines of
 * tmux format for no gain. The roles they are filled from are the panel's:
 *
 *   BASE→bg  OVERLAY→edge  MUTED→dim  SUBTLE→soft  TEXT→text
 *   GOLD→warn  PINE→ok  FOAM→ok  IRIS→accent
 *
 * `PINE` and `FOAM` both take `ok` because the palette has one green-ish status
 * colour by design — the status line uses PINE for the active pane border and
 * FOAM for copy mode, and those wanting the same value is correct, not a
 * shortcut.
 */
export function statusPaletteBlock(palette: Palette): string {
  const roles: Array<[string, string]> = [
    ['BASE', palette.bg],
    ['OVERLAY', palette.edge],
    ['MUTED', palette.dim],
    ['SUBTLE', palette.soft],
    ['TEXT', palette.text],
    ['GOLD', palette.warn],
    ['PINE', palette.ok],
    ['FOAM', palette.ok],
    ['IRIS', palette.accent],
  ];
  return [
    '# -- status-palette (managed by switch-theme) --',
    ...roles.map(([name, hex]) => `%hidden ST_${name}="${hex}"`),
    '# -- end status-palette --',
  ].join('\n');
}

/**
 * Uncomment the target family's plugin lines, comment out every other family's,
 * and rewrite the variant line the target owns.
 *
 * Exported for the tests, which is also the honest reason it takes text rather
 * than a path: the interesting behaviour is entirely in what it does to a
 * hand-written config, and that is worth asserting on directly.
 */
export function retargetTmuxConf(
  text: string,
  theme: ThemeName,
): { text: string; enabled: number; disabled: number; warnings: string[] } {
  const { family, variant } = EXTERNAL[theme].tmux;
  const variantLine = TMUX_VARIANT_LINES[family];
  const warnings: string[] = [];
  let enabled = 0;
  let disabled = 0;
  let variantSet = false;

  const out = text.split('\n').map((line) => {
    const [, indent = '', hashes = '', raw = ''] = TMUX_COMMENT.exec(line) ?? [];
    let content = raw.trimEnd();
    let owner = TMUX_OWNED_LINES[content];
    if (owner === undefined) {
      for (const [candidate, spec] of Object.entries(TMUX_VARIANT_LINES)) {
        if (!spec?.match.test(content)) continue;
        owner = candidate as TmuxFamily;
        if (owner === family && variant) {
          content = spec.line(variant);
          variantSet = true;
        }
        break;
      }
    }
    if (owner === undefined) return line;
    if (owner === family) {
      if (hashes) enabled++;
      return `${indent}${content}`;
    }
    if (!hashes) disabled++;
    return hashes ? line : `${indent}# ${content}`;
  });

  if (variant && variantLine && !variantSet) {
    warnings.push(`no @${family} variant line found — set '${variant}' by hand`);
  }

  let next = out.join('\n');
  if (STATUS_PALETTE_BLOCK.test(next)) {
    next = next.replace(STATUS_PALETTE_BLOCK, statusPaletteBlock(THEMES[theme].palette));
  } else {
    warnings.push('no status-palette block found — left untouched');
  }
  return { text: next, enabled, disabled, warnings };
}

async function syncTmux(theme: ThemeName, config: ThemeSyncConfig, notes: Notes): Promise<void> {
  const { family } = EXTERNAL[theme].tmux;
  await editFile(config.tmuxConf, notes, (text) => {
    const result = retargetTmuxConf(text, theme);
    const parts = [`status palette → ${theme}`];
    if (result.enabled || result.disabled)
      parts.push(`${family}: ${result.enabled} on, ${result.disabled} off`);
    return { text: result.text, note: [...parts, ...result.warnings].join('; ') };
  });
}

/**
 * `tmux source-file`, when there is a server to tell.
 *
 * Not fatal either way: the config on disk is correct regardless, and the next
 * server to start will read it.
 */
async function reloadTmux(config: ThemeSyncConfig, notes: Notes): Promise<string | undefined> {
  if (!(await exists(config.tmuxConf))) return undefined;
  const { code, stderr } = await run('tmux', ['source-file', config.tmuxConf], {
    env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
  });
  if (code === 0) {
    notes.note(config.tmuxConf, 'sourced into the running server');
    return undefined;
  }
  // No server running is the normal case when the panel is open on its own, and
  // is not worth a warning; anything else the user should hear about.
  if (stderr.includes('no server running')) return undefined;
  notes.note(config.tmuxConf, `source-file failed: ${stderr.trim() || `exit ${code}`}`);
  return `tmux source-file ${tildify(config.tmuxConf)}`;
}

// ── the whole gesture ─────────────────────────────────────────────────

/**
 * Apply `theme` to Ghostty, Neovim and tmux.
 *
 * Sequential rather than `Promise.all`: the three surfaces are three or four
 * small file rewrites, the report reads in a fixed order, and one of them
 * shelling out to tmux at the same time as another renames a file in the user's
 * dotfiles is not a race worth inviting for a few milliseconds.
 */
export async function syncTheme(
  theme: ThemeName,
  config: ThemeSyncConfig = DEFAULT_THEME_SYNC,
): Promise<ThemeSyncReport> {
  if (!config.enabled) {
    return { theme, surfaces: [], skipped: 'themeSync is off in config.json' };
  }

  const surfaces: SurfaceResult[] = [];
  const surface = async (
    name: Surface,
    apply: (notes: Notes) => Promise<string | undefined>,
  ): Promise<void> => {
    const notes = new Notes();
    try {
      const reload = await apply(notes);
      surfaces.push({ surface: name, notes: notes.lines, changed: notes.changed, reload });
    } catch (error) {
      // One unwritable file must not cost the other two their repaint, and it
      // certainly must not fail the click — the panel is already the new colour.
      surfaces.push({
        surface: name,
        notes: notes.lines,
        changed: notes.changed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await surface('ghostty', async (notes) => {
    await syncGhostty(theme, config, notes);
    // No CLI and no signal to send: Ghostty reloads on a keystroke into its own
    // frontmost window, which is a thing to tell the user, not to fake.
    return notes.changed ? 'ghostty: ⌘⇧, to reload' : undefined;
  });

  await surface('nvim', async (notes) => {
    await syncNvim(theme, config, notes);
    // New instances pick it up; the open ones are somebody's editor, mid-edit.
    return notes.changed ? `nvim: :colorscheme ${EXTERNAL[theme].nvim}` : undefined;
  });

  await surface('tmux', async (notes) => {
    await syncTmux(theme, config, notes);
    if (!config.reloadTmux) {
      return notes.changed ? `tmux source-file ${tildify(config.tmuxConf)}` : undefined;
    }
    return notes.changed ? await reloadTmux(config, notes) : undefined;
  });

  return { theme, surfaces };
}

/**
 * The report as one line, for the toast.
 *
 * Short on purpose: the toast is up for three and a half seconds and the panel
 * has already repainted, so the only things worth saying are which surfaces
 * moved and what is still waiting on the user. A failure says *why* — a path
 * that moved or a file that is read-only is not something the user can guess
 * from "ghostty failed", and there is no second place this report is written.
 */
export function summarise(report: ThemeSyncReport): string {
  if (report.skipped) return report.skipped;
  const changed = report.surfaces.filter((s) => s.changed).map((s) => s.surface);
  const failed = report.surfaces.filter((s) => s.error);
  const reloads = report.surfaces.map((s) => s.reload).filter((r): r is string => Boolean(r));

  const parts: string[] = [];
  if (changed.length > 0) parts.push(changed.join(', '));
  else if (failed.length === 0) parts.push('already in step');
  for (const surface of failed) parts.push(`${surface.surface} failed: ${surface.error}`);
  if (reloads.length > 0) parts.push(reloads.join(' · '));
  return parts.join(' — ');
}
