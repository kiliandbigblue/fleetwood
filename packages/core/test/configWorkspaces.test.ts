import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-workspaces-'));
process.env.FLEETWOOD_HOME = home;
const { loadConfig } = await import('../src/config.ts');
const { CONFIG_FILE } = await import('../src/paths.ts');

const write = (value: unknown): Promise<void> =>
  writeFile(CONFIG_FILE, JSON.stringify(value, null, 2), 'utf8');

test('no workspaces unless some are named', async () => {
  await write({});
  assert.deepEqual((await loadConfig()).workspaces, []);
});

test('a workspace under ~ is read back absolute, as tmux reports session_path', async () => {
  await write({ workspaces: ['~/projects/os', '/srv/ops', '~other/x'] });
  assert.deepEqual((await loadConfig()).workspaces, [
    join(homedir(), 'projects/os'),
    '/srv/ops',
    // Only `~` and `~/` are ours to expand; another user's home is not.
    '~other/x',
  ]);
});

test('a hand-edit of the wrong shape leaves the list empty or trimmed', async () => {
  await write({ workspaces: '~/projects/os' });
  assert.deepEqual((await loadConfig()).workspaces, []);
  await write({ workspaces: ['~', 42, '', null] });
  assert.deepEqual((await loadConfig()).workspaces, [homedir()]);
});
