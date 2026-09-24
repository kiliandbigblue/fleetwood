import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-repos-'));
process.env.FLEETWOOD_HOME = home;
const { buildIndex } = await import('../src/repoIndex.ts');
const { CONFIG_FILE } = await import('../src/paths.ts');

const projects = join(home, 'projects');
const dotfiles = join(home, 'dotfiles');

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

await mkdir(join(projects, 'reflow'), { recursive: true });
await mkdir(join(projects, 'scratch'));
await mkdir(join(projects, '.agents'));
git(join(projects, 'reflow'), 'init', '-q');
git(join(projects, 'reflow'), 'remote', 'add', 'origin', 'git@github.com:acme/reflow.git');
await mkdir(join(dotfiles, '.config'), { recursive: true });
git(dotfiles, 'init', '-q');
git(dotfiles, 'remote', 'add', 'origin', 'https://github.com/me/dotfiles.git');
await writeFile(CONFIG_FILE, JSON.stringify({ projectRoots: [projects, dotfiles] }), 'utf8');

test('a root that is itself a checkout is listed as one project', async () => {
  const { repos } = await buildIndex();
  assert.deepEqual(
    repos.map((r) => [r.path, r.isRepo, r.nameWithOwner]),
    [
      [join(projects, 'reflow'), true, 'acme/reflow'],
      [join(projects, 'scratch'), false, undefined],
      [dotfiles, true, 'me/dotfiles'],
    ],
  );
});
