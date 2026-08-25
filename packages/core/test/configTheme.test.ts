import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-theme-'));
process.env.FLEETWOOD_HOME = home;
const { loadConfig, saveTheme, saveBgOpacity, DEFAULT_CONFIG } = await import('../src/config.ts');
const { CONFIG_FILE } = await import('../src/paths.ts');

const write = (value: unknown): Promise<void> =>
  writeFile(CONFIG_FILE, JSON.stringify(value, null, 2), 'utf8');
const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>;

test('no config file at all comes up in the default theme', async () => {
  await rm(CONFIG_FILE, { force: true });
  assert.equal((await loadConfig()).theme, 'rose-pine');
  assert.equal(DEFAULT_CONFIG.theme, 'rose-pine');
});

test('a configured theme is read back', async () => {
  await write({ theme: 'catppuccin-frappe' });
  assert.equal((await loadConfig()).theme, 'catppuccin-frappe');
});

test('a misspelt theme falls back instead of leaving the UI unpainted', async () => {
  await write({ theme: 'catpuccin' });
  assert.equal((await loadConfig()).theme, 'rose-pine');

  // Including the shapes a hand-edit produces: the family without the flavour,
  // the label rather than the slug, and the wrong type entirely.
  for (const bad of ['catppuccin', 'Catppuccin Mocha', 42, null, {}]) {
    await write({ theme: bad });
    assert.equal((await loadConfig()).theme, 'rose-pine', `${JSON.stringify(bad)} should fall back`);
  }
});

test('saveTheme writes only the theme, leaving the rest of the file alone', async () => {
  // A deliberately partial config: the shallow merge exists so a file like this
  // keeps inheriting new defaults, and saving a colour must not end that.
  await write({ editor: 'hx', poll: { tmuxMs: 250 } });
  await saveTheme('tokyonight-storm');

  assert.deepEqual(await read(), {
    editor: 'hx',
    poll: { tmuxMs: 250 },
    theme: 'tokyonight-storm',
  });

  const config = await loadConfig();
  assert.equal(config.theme, 'tokyonight-storm');
  assert.equal(config.editor, 'hx');
  // Still inheriting the defaults it never mentioned.
  assert.equal(config.poll.processMs, DEFAULT_CONFIG.poll.processMs);
  assert.equal(config.taskRoot, DEFAULT_CONFIG.taskRoot);
});

test('saveTheme replaces a theme already recorded', async () => {
  await write({ theme: 'rose-pine-moon', editor: 'nvim' });
  await saveTheme('catppuccin-mocha');
  assert.deepEqual(await read(), { theme: 'catppuccin-mocha', editor: 'nvim' });
});

test('saveTheme creates the file when there is none', async () => {
  await rm(CONFIG_FILE, { force: true });
  await saveTheme('catppuccin-macchiato');
  assert.deepEqual(await read(), { theme: 'catppuccin-macchiato' });
});

test('saveTheme refuses to clobber a config it cannot parse', async () => {
  // Recording a colour scheme is not worth losing someone's settings over, so a
  // malformed file is left exactly as it is and the caller hears about it.
  const damaged = '{ "editor": "nvim",\n  // a comment JSON does not allow\n}';
  await writeFile(CONFIG_FILE, damaged, 'utf8');
  await assert.rejects(() => saveTheme('rose-pine'));
  assert.equal(await readFile(CONFIG_FILE, 'utf8'), damaged);
});

test('no config file at all comes up opaque', async () => {
  await rm(CONFIG_FILE, { force: true });
  assert.equal((await loadConfig()).bgOpacity, 1);
  assert.equal(DEFAULT_CONFIG.bgOpacity, 1);
});

test('a configured background opacity is read back, out-of-range ones clamped', async () => {
  await write({ bgOpacity: 0.55 });
  assert.equal((await loadConfig()).bgOpacity, 0.55);

  // A hand edit is the only way to get here — the slider cannot produce these —
  // and an invisible window is not a legible way to report the mistake.
  for (const [written, expected] of [[0, 0.2], [-2, 0.2], [5, 1], ['0.5', 1], [null, 1]] as const) {
    await write({ bgOpacity: written });
    assert.equal((await loadConfig()).bgOpacity, expected, `${JSON.stringify(written)}`);
  }
});

test('saveBgOpacity writes only that key, clamped', async () => {
  await write({ theme: 'rose-pine-moon', editor: 'hx' });
  await saveBgOpacity(0.7);
  assert.deepEqual(await read(), { theme: 'rose-pine-moon', editor: 'hx', bgOpacity: 0.7 });

  await saveBgOpacity(9);
  assert.deepEqual(await read(), { theme: 'rose-pine-moon', editor: 'hx', bgOpacity: 1 });
});

test('the theme and the opacity do not overwrite each other', async () => {
  // Two writers on one file, one key each: picking a flavour must not reset the
  // transparency the slider just set, or vice versa.
  await rm(CONFIG_FILE, { force: true });
  await saveBgOpacity(0.65);
  await saveTheme('tokyonight-moon');
  assert.deepEqual(await read(), { bgOpacity: 0.65, theme: 'tokyonight-moon' });
});
