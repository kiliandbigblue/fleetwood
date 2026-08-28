import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/exec.ts';
import { difitCommand } from '../src/actions.ts';
import { localDefaultBranch, reviewBase } from '../src/worktree.ts';

/**
 * A throwaway repo on `trunk`, with no remote.
 *
 * The branch is deliberately not `main`: naming it `main` would let a `main`
 * assumption pass every test in this file, which is the one thing they exist to
 * catch.
 */
async function scratchRepo(branch = 'trunk'): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fw-rb-')));
  const repo = join(root, 'reflow');
  await mkdir(repo, { recursive: true });
  await run('git', ['-C', repo, 'init', '-q', '-b', branch]);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', repo, 'config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-qm', 'first']);
  return repo;
}

/**
 * Give a scratch repo the refs a clone would have, without cloning one.
 *
 * `git push` is not usable here: it needs a second repo, and it runs whatever
 * pre-push hooks the machine has configured globally — which on a protected
 * branch name is a refusal, and a test that fails on the developer's git config
 * is testing the wrong thing. `update-ref` writes what the code actually reads.
 */
async function fakeOrigin(repo: string, branch: string): Promise<void> {
  const head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await run('git', ['-C', repo, 'update-ref', `refs/remotes/origin/${branch}`, head]);
  await run('git', [
    '-C',
    repo,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    `refs/remotes/origin/${branch}`,
  ]);
}

test('the review base is origin/HEAD wherever there is a remote', async () => {
  const repo = await scratchRepo('dev');
  await fakeOrigin(repo, 'dev');

  // The remote-tracking ref, prefix kept: a task worktree's local `dev` may be
  // stale or absent, while `origin/dev` is current as of the last fetch.
  assert.equal(await localDefaultBranch(repo), 'origin/dev');
  assert.equal(await reviewBase(repo), 'origin/dev');
});

test('a repo that was never pushed anywhere still has a trunk to review against', async () => {
  // No remote at all — fleetwood's own worktrees. Falling over here would leave
  // the review button dead in exactly the repos worked on locally.
  const repo = await scratchRepo('main');
  assert.equal(await localDefaultBranch(repo), undefined);
  assert.equal(await reviewBase(repo), 'main');
});

test('the local trunk is looked up, never assumed', async () => {
  // `master`, not `main`, and no remote: an assumed `main` would name a branch
  // that does not exist and difit would refuse the base outright.
  const repo = await scratchRepo('master');
  assert.equal(await reviewBase(repo), 'master');
});

test('a repo with no trunk under any known name says so rather than guessing', async () => {
  const repo = await scratchRepo('wip/experiment');
  assert.equal(await reviewBase(repo), undefined);
});

test('the base branch is compared with merge-base, and new files are included', () => {
  // Both flags carry a reason a rename would quietly break: `--merge-base` keeps
  // commits landed on the trunk since the branch cut out of the review, and
  // `--include-untracked` is what stops difit stopping to ask about new files.
  assert.equal(
    difitCommand('origin/dev'),
    'difit . origin/dev --merge-base --include-untracked',
  );
});
