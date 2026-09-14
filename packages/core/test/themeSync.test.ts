import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load and the backups land under it,
// so this has to be set before the first import — hence the dynamic ones below.
const home = await mkdtemp(join(tmpdir(), 'fw-theme-sync-'));
process.env.FLEETWOOD_HOME = join(home, '.fleetwood');
const { ghosttyTheme, retargetTmuxConf, statusPaletteBlock, summarise, syncTheme } = await import(
  '../src/themeSync.ts'
);
const { THEMES } = await import('../src/theme.ts');
const { BACKUP_DIR } = await import('../src/paths.ts');
import type { ThemeSyncConfig } from '../src/themeSync.ts';

/**
 * A tmux.conf with the shape that matters: every theme family's block present
 * and commented out, a variant line per family, the managed palette block, and
 * — the part most likely to break — hand comments that look like theme lines
 * without being any family's.
 */
const TMUX_CONF = `# Plugins
set -g @plugin 'tmux-plugins/tpm'

# set -g @plugin "janoamaral/tokyo-night-tmux"
# set -g @tokyo-night-tmux_transparent 1

# set -g @plugin 'rose-pine/tmux'
# set -g @rose_pine_variant 'main'
# set -g @rose_pine_bar_bg_disable 'on' # Disables background color
# # Some of these are mutually exclusive, test which one you like

# set -g @catppuccin_flavor 'mocha'
# run ~/.config/tmux/plugins/catppuccin/tmux/catppuccin.tmux
# set -g status-left ""

# set -g @plugin 'dracula/tmux'

run '~/.tmux/plugins/tpm/tpm'

# -- status-palette (managed by switch-theme) --
%hidden ST_BASE="#000000"
%hidden ST_TEXT="#ffffff"
# -- end status-palette --

set -g status-style "bg=#{ST_BASE},fg=#{ST_SUBTLE}"
`;

const GHOSTTY_CONF = `font-family = Berkeley Mono
font-size = 14
theme = Rose Pine
background-opacity = 0.9
`;

const NVIM_CONF = `function ColorMyPencils()
    vim.cmd.colorscheme("rose-pine") -- the one that wins
    vim.api.nvim_set_hl(0, "TelescopeNormal", { bg = "none" })
end
`;

/** A fresh tree of the four files, and the config pointing at them. */
async function fixture(): Promise<ThemeSyncConfig> {
  const root = await mkdtemp(join(home, 'case-'));
  const live = join(root, 'ghostty-live');
  const dots = join(root, 'dotfiles');
  await mkdir(join(dots, 'themes'), { recursive: true });
  await mkdir(live, { recursive: true });
  const config: ThemeSyncConfig = {
    enabled: true,
    ghosttyConfig: join(live, 'config'),
    ghosttyThemeDir: join(live, 'themes'),
    ghosttyDotfileConfig: join(dots, 'config'),
    ghosttyDotfileThemeDir: join(dots, 'themes'),
    nvimColorscheme: join(dots, 'colorscheme.lua'),
    tmuxConf: join(dots, '.tmux.conf'),
    // Never in tests: the developer running them has a tmux server, and a unit
    // test has no business sourcing a fixture into it.
    reloadTmux: false,
  };
  await writeFile(config.ghosttyConfig, GHOSTTY_CONF, 'utf8');
  await writeFile(config.ghosttyDotfileConfig, GHOSTTY_CONF, 'utf8');
  await writeFile(config.nvimColorscheme, NVIM_CONF, 'utf8');
  await writeFile(config.tmuxConf, TMUX_CONF, 'utf8');
  return config;
}

const read = (path: string): Promise<string> => readFile(path, 'utf8');

test('one theme reaches all three surfaces', async () => {
  const config = await fixture();
  const report = await syncTheme('catppuccin-macchiato', config);

  assert.deepEqual(
    report.surfaces.map((s) => s.surface),
    ['ghostty', 'nvim', 'tmux'],
  );
  assert.ok(report.surfaces.every((s) => s.changed && !s.error));

  // Ghostty: the built-in name, in both files, and nothing else touched.
  for (const path of [config.ghosttyConfig, config.ghosttyDotfileConfig]) {
    const text = await read(path);
    assert.match(text, /^theme = Catppuccin Macchiato$/m);
    assert.match(text, /^font-size = 14$/m, 'only the theme line may move');
    assert.match(text, /^background-opacity = 0\.9$/m);
  }

  assert.match(await read(config.nvimColorscheme), /colorscheme\("catppuccin-macchiato"\)/);

  const tmux = await read(config.tmuxConf);
  assert.match(tmux, /^set -g @catppuccin_flavor 'macchiato'$/m, 'uncommented and retargeted');
  assert.match(tmux, /^run ~\/\.config\/tmux\/plugins\/catppuccin\/tmux\/catppuccin\.tmux$/m);
  assert.match(tmux, /^# set -g @plugin "janoamaral\/tokyo-night-tmux"$/m, 'others stay off');
});

test('the tmux status palette is the panel palette, not a second copy of it', async () => {
  const config = await fixture();
  await syncTheme('tokyonight-moon', config);
  const { palette } = THEMES['tokyonight-moon'];

  const tmux = await read(config.tmuxConf);
  assert.ok(tmux.includes(statusPaletteBlock(palette)));
  assert.match(tmux, new RegExp(`^%hidden ST_BASE="${palette.bg}"$`, 'm'));
  assert.match(tmux, new RegExp(`^%hidden ST_IRIS="${palette.accent}"$`, 'm'));
  // Both greens come off the one `ok` role; the old script special-cased Main.
  assert.match(tmux, new RegExp(`^%hidden ST_PINE="${palette.ok}"$`, 'm'));
  assert.match(tmux, new RegExp(`^%hidden ST_FOAM="${palette.ok}"$`, 'm'));
  assert.ok(!tmux.includes('#000000'), 'the placeholder block is gone');
  // The marker is left as the skill's script writes it, so both can find it.
  assert.match(tmux, /# -- status-palette \(managed by switch-theme\) --/);
});

test('a Helldivers flavour generates its Ghostty theme, since there is no built-in', async () => {
  const config = await fixture();
  await syncTheme('helldivers-illuminate', config);
  const { palette } = THEMES['helldivers-illuminate'];

  assert.match(await read(config.ghosttyConfig), /^theme = helldivers-illuminate$/m);
  for (const dir of [config.ghosttyThemeDir, config.ghosttyDotfileThemeDir]) {
    const text = await read(join(dir, 'helldivers-illuminate'));
    assert.equal(text, ghosttyTheme(palette));
    assert.match(text, new RegExp(`^background = ${palette.bg}$`, 'm'));
    assert.match(text, new RegExp(`^palette = 0=${palette.edge}$`, 'm'));
    assert.match(text, new RegExp(`^palette = 5=${palette.accent}$`, 'm'));
  }
  // Only the chosen one: switching theme is not an excuse to rewrite the others.
  assert.deepEqual(await readdir(config.ghosttyThemeDir), ['helldivers-illuminate']);
});

test('applying the same theme twice changes nothing the second time', async () => {
  const config = await fixture();
  await syncTheme('rose-pine-moon', config);
  const after = await Promise.all(
    [config.ghosttyConfig, config.nvimColorscheme, config.tmuxConf].map(read),
  );

  const again = await syncTheme('rose-pine-moon', config);
  assert.ok(
    again.surfaces.every((s) => !s.changed),
    'a second pass must report nothing moved',
  );
  assert.deepEqual(
    await Promise.all([config.ghosttyConfig, config.nvimColorscheme, config.tmuxConf].map(read)),
    after,
  );
  assert.equal(summarise(again), 'already in step');
});

test('comments that are not a theme family are left exactly as written', async () => {
  const config = await fixture();
  await syncTheme('rose-pine', config);
  const tmux = await read(config.tmuxConf);

  // Not in the owned-lines table, so invisible to the toggle — including the
  // rose-pine option that carries a trailing comment, and the `# #` line.
  assert.match(tmux, /^# set -g @rose_pine_bar_bg_disable 'on' # Disables background color$/m);
  assert.match(tmux, /^# # Some of these are mutually exclusive, test which one you like$/m);
  assert.match(tmux, /^# set -g @plugin 'dracula\/tmux'$/m, 'a retired plugin stays retired');
  assert.match(tmux, /^set -g @plugin 'tmux-plugins\/tpm'$/m, 'tpm is nobody’s theme');
});

test('switching families turns the previous one off', async () => {
  const config = await fixture();
  await syncTheme('catppuccin-mocha', config);
  assert.match(await read(config.tmuxConf), /^set -g @catppuccin_flavor 'mocha'$/m);

  await syncTheme('tokyonight-storm', config);
  const tmux = await read(config.tmuxConf);
  assert.match(tmux, /^set -g @plugin "janoamaral\/tokyo-night-tmux"$/m);
  assert.match(tmux, /^# set -g @catppuccin_flavor 'mocha'$/m, 'catppuccin back off');
  assert.match(tmux, /^# run ~\/\.config\/tmux\/plugins\/catppuccin\/tmux\/catppuccin\.tmux$/m);
  assert.match(tmux, /^# set -g status-left ""$/m);
});

test('a Helldivers flavour loads no tmux plugin at all', async () => {
  const config = await fixture();
  await syncTheme('helldivers-terminids', config);
  const tmux = await read(config.tmuxConf);

  for (const line of [
    'set -g @plugin "janoamaral/tokyo-night-tmux"',
    "set -g @plugin 'rose-pine/tmux'",
    'run ~/.config/tmux/plugins/catppuccin/tmux/catppuccin.tmux',
  ]) {
    assert.ok(tmux.includes(`# ${line}`), `${line} must stay commented`);
  }
  // The status line is hand-rolled, so the palette is the whole of the change.
  assert.ok(tmux.includes(statusPaletteBlock(THEMES['helldivers-terminids'].palette)));
});

test('every file is backed up before it is rewritten', async () => {
  const config = await fixture();
  await rm(BACKUP_DIR, { recursive: true, force: true });
  await syncTheme('catppuccin-frappe', config);

  const backups = await readdir(BACKUP_DIR);
  for (const name of ['config', 'colorscheme.lua', '.tmux.conf']) {
    assert.ok(
      backups.some((file) => file.startsWith(`${name}.`)),
      `expected a backup of ${name}, got ${backups.join(', ')}`,
    );
  }
  // The live and dotfile ghostty configs are both called `config`.
  assert.equal(backups.filter((file) => file.startsWith('config.')).length, 2);

  // And the copy is the file as it was, not as it now is.
  const tmuxBackup = backups.find((file) => file.startsWith('.tmux.conf.')) as string;
  assert.equal(await read(join(BACKUP_DIR, tmuxBackup)), TMUX_CONF);
});

test('a missing file is skipped, not an error — a dotfile that moved cannot fail the click', async () => {
  const config = await fixture();
  await rm(config.nvimColorscheme);
  await rm(config.tmuxConf);

  const report = await syncTheme('tokyonight-night', config);
  assert.ok(report.surfaces.every((s) => !s.error));
  const nvim = report.surfaces.find((s) => s.surface === 'nvim');
  assert.equal(nvim?.changed, false);
  assert.match(nvim?.notes.join('\n') ?? '', /missing — skipped/);
  // Ghostty still took it.
  assert.match(await read(config.ghosttyConfig), /^theme = TokyoNight Night$/m);
  assert.equal(summarise(report), 'ghostty — ghostty: ⌘⇧, to reload');
});

test('a config with no line to match warns rather than inventing one', async () => {
  const config = await fixture();
  await writeFile(config.ghosttyConfig, 'font-size = 14\n', 'utf8');
  await writeFile(config.tmuxConf, 'set -g status on\n', 'utf8');

  const report = await syncTheme('rose-pine', config);
  const notes = report.surfaces.flatMap((s) => s.notes).join('\n');
  assert.match(notes, /no `theme =` line found — left untouched/);
  assert.match(notes, /no status-palette block found/);
  assert.equal(await read(config.ghosttyConfig), 'font-size = 14\n', 'left alone');
});

test('a variant the config has no line for is reported, not silently dropped', () => {
  const result = retargetTmuxConf("set -g @plugin 'rose-pine/tmux'\n", 'rose-pine-moon');
  assert.deepEqual(result.warnings, [
    "no @rose-pine variant line found — set 'moon' by hand",
    'no status-palette block found — left untouched',
  ]);
});

test('themeSync off leaves every file alone', async () => {
  const config = await fixture();
  const report = await syncTheme('catppuccin-mocha', { ...config, enabled: false });

  assert.deepEqual(report.surfaces, []);
  assert.equal(summarise(report), 'themeSync is off in config.json');
  assert.equal(await read(config.ghosttyConfig), GHOSTTY_CONF);
  assert.equal(await read(config.tmuxConf), TMUX_CONF);
});

test('the reload the user still owes is named per surface', async () => {
  const config = await fixture();
  const report = await syncTheme('tokyonight-storm', config);
  const reloads = report.surfaces.map((s) => s.reload);

  assert.deepEqual(reloads, [
    'ghostty: ⌘⇧, to reload',
    'nvim: :colorscheme tokyonight-storm',
    // reloadTmux is off in the fixture, so the command is handed back.
    `tmux source-file ${config.tmuxConf}`,
  ]);
});

test('a generated Ghostty theme reproduces the checked-in helldivers files', () => {
  // The file shape these three flavours already ship as, asserted once so a
  // change to the derivation is visible rather than merely a diff in ~/dotfiles.
  const text = ghosttyTheme(THEMES['helldivers-automatons'].palette);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 22, '16 palette slots plus six named colours');
  assert.equal(lines[0], 'palette = 0=#342628');
  assert.equal(lines[16], 'background = #1a1516');
  assert.equal(lines[21], 'selection-foreground = #e6dcdd');
});

test.after(() => rm(home, { recursive: true, force: true }));
