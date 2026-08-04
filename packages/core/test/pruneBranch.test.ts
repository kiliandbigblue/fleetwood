import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneEmptyBranch } from '../src/task.ts';

/**
 * These run against real git repositories in a temp dir.
 *
 * The logic they cover decides whether to delete a branch, so being wrong is
 * either litter (too timid) or lost work (too eager) — worth the cost of real
 * repos over mocks.
 */
/**
 * Git isolated from the developer's own configuration.
 *
 * Without this the tests inherit `core.hooksPath` — a global pre-push hook here
 * rejects the all-zeros SHA of a brand-new ref, so the fixtures could not even be
 * created. Tests must not depend on whose machine they run on.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

/** Same isolation, for the calls that create the fixtures themselves. */
function gitAt(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=', ...args], { encoding: 'utf8', env: GIT_ENV });
}

/** An "origin" plus a clone of it, with one commit on the default branch. */
function makeRepoPair(): { origin: string; clone: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'fw-prune-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  gitAt('init', '--bare', '-b', 'master', origin);
  gitAt('init', '-b', 'master', seed);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'master');

  gitAt('clone', origin, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'test');
  return { origin, clone, root };
}

test('an empty, unpushed branch is deleted', async () => {
  const { clone, root } = makeRepoPair();
  try {
    git(clone, 'branch', 'fix/x-empty', 'origin/master');
    assert.equal(await pruneEmptyBranch(clone, 'fix/x-empty'), true);
    assert.ok(!git(clone, 'branch', '--list', 'fix/x-empty'), 'branch should be gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a branch with a commit is kept', async () => {
  const { clone, root } = makeRepoPair();
  try {
    git(clone, 'checkout', '-b', 'fix/x-work', 'origin/master');
    writeFileSync(join(clone, 'b.txt'), 'work\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'real work');
    git(clone, 'checkout', 'master');

    assert.equal(await pruneEmptyBranch(clone, 'fix/x-work'), false);
    assert.ok(git(clone, 'branch', '--list', 'fix/x-work'), 'branch with work must survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pushed branch is kept even when it has no commits of its own', async () => {
  const { clone, root } = makeRepoPair();
  try {
    git(clone, 'branch', 'fix/x-pushed', 'origin/master');
    git(clone, 'push', 'origin', 'fix/x-pushed');
    git(clone, 'fetch', 'origin');

    assert.equal(await pruneEmptyBranch(clone, 'fix/x-pushed'), false);
    assert.ok(git(clone, 'branch', '--list', 'fix/x-pushed'), 'a pushed branch is not ours to delete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale local default branch does not make an empty branch look used', async () => {
  // The regression: proto's local master was 45 commits behind origin/master, so
  // comparing against the local ref counted 45 commits on a brand-new branch and
  // every task left its branches behind.
  const { origin, clone, root } = makeRepoPair();
  try {
    const other = join(root, 'other');
    gitAt('clone', origin, other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'test');
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(other, `c${i}.txt`), `${i}\n`);
      git(other, 'add', '.');
      git(other, 'commit', '-m', `upstream ${i}`);
    }
    git(other, 'push', 'origin', 'master');

    // The clone fetches but never fast-forwards its local master.
    git(clone, 'fetch', 'origin');
    assert.equal(git(clone, 'rev-list', '--count', 'master..origin/master'), '3', 'local base is stale');

    git(clone, 'branch', 'fix/x-fresh', 'origin/master');
    assert.equal(await pruneEmptyBranch(clone, 'fix/x-fresh'), true, 'empty branch must still be recognised');
    assert.ok(!git(clone, 'branch', '--list', 'fix/x-fresh'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
