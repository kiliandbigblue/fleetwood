import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/exec.ts';
import { ensureWorktree, listWorktrees } from '../src/worktree.ts';
import { worktreeDirName } from '../src/naming.ts';

/**
 * A throwaway repo with one commit on `main`, standing in for `~/projects/reflow`.
 *
 * `realpath` because git reports worktree paths resolved, and on macOS the temp
 * directory is reached through `/var` → `/private/var`. Comparing the two raw is
 * how a path check silently stops matching.
 */
async function scratchRepo(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fw-wt-')));
  const repo = join(root, 'reflow');
  await mkdir(repo, { recursive: true });
  await run('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', repo, 'config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-qm', 'first']);
  return { root, repo };
}

const OPTS = { offline: true, base: 'main' } as const;

test('a task folder holds one worktree per branch, not one per repo', async () => {
  const { root, repo } = await scratchRepo();
  const task = join(root, 'task');
  await mkdir(task, { recursive: true });

  const branches = [
    'feature/orders-use-order-type',
    'feature/orders-dual-write-order-type',
    'feature/orders-drop-b2b-flag',
  ];
  for (const branch of branches) {
    const target = join(task, worktreeDirName('reflow', branch));
    const result = await ensureWorktree(repo, branch, target, OPTS);
    assert.ok(result.ok, `${branch}: ${result.detail}`);
    assert.equal(result.branch, branch);
  }

  // The whole point: three layers, three checkouts, each on the branch it names.
  assert.deepEqual((await readdir(task)).sort(), [
    'reflow-orders-drop-b2b-flag',
    'reflow-orders-dual-write-order-type',
    'reflow-orders-use-order-type',
  ]);
  const live = (await listWorktrees(repo)).filter((w) => w.path.startsWith(`${task}/`));
  assert.deepEqual(live.map((w) => w.branch).sort(), [...branches].sort());
});

test('a target already holding another branch is an error, not a silent reuse', async () => {
  const { root, repo } = await scratchRepo();
  const task = join(root, 'task');
  await mkdir(task, { recursive: true });

  // The old naming: one directory named after the repo.
  const target = join(task, 'reflow');
  const first = await ensureWorktree(repo, 'feature/orders-use-order-type', target, OPTS);
  assert.ok(first.ok);

  // Asking the same directory for a second branch used to return ok, having done
  // nothing, with the *first* branch reported back — which is what made a stacked
  // task impossible to build with `fw task add`.
  const second = await ensureWorktree(repo, 'feature/orders-dual-write-order-type', target, OPTS);
  assert.equal(second.ok, false);
  assert.match(second.detail, /already holds feature\/orders-use-order-type/);
  assert.notEqual(second.branch, 'feature/orders-use-order-type');
});

test('asking again for the branch that is there is still a reuse', async () => {
  const { root, repo } = await scratchRepo();
  const task = join(root, 'task');
  await mkdir(task, { recursive: true });
  const target = join(task, worktreeDirName('reflow', 'feature/orders-use-order-type'));

  const first = await ensureWorktree(repo, 'feature/orders-use-order-type', target, OPTS);
  const again = await ensureWorktree(repo, 'feature/orders-use-order-type', target, OPTS);
  assert.equal(first.created, true);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.branch, 'feature/orders-use-order-type');
});

test('a branch checked out elsewhere says where, rather than failing obscurely', async () => {
  const { root, repo } = await scratchRepo();
  const task = join(root, 'task');
  await mkdir(task, { recursive: true });

  await ensureWorktree(repo, 'feature/orders-use-order-type', join(task, 'reflow-orders-use-order-type'), OPTS);
  const clash = await ensureWorktree(repo, 'feature/orders-use-order-type', join(task, 'elsewhere'), OPTS);
  assert.equal(clash.ok, false);
  assert.match(clash.detail, /already checked out at/);
});

/**
 * A clone of `origin`, so origin/<branch> refs are real and can be moved apart
 * from the local ones — the drift this whole freshness question is about.
 */
async function clonedRepo(): Promise<{ root: string; origin: string; repo: string }> {
  const { root, repo: origin } = await scratchRepo();
  const repo = join(root, 'reflow-clone');
  await run('git', ['clone', '-q', origin, repo]);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', repo, 'config', 'user.name', 'test']);
  return { root, origin, repo };
}

async function commit(repo: string, file: string, message: string): Promise<string> {
  await writeFile(join(repo, file), `${message}\n`, 'utf8');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-qm', message]);
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function headOf(path: string): Promise<string> {
  const { stdout } = await run('git', ['-C', path, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

test('a new branch starts from origin/default when origin has moved ahead', async () => {
  const { root, origin, repo } = await clonedRepo();
  const task = join(root, 'task');
  const ahead = await commit(origin, 'b.txt', 'pushed by someone else');

  const target = join(task, worktreeDirName('reflow', 'fix/thing'));
  const result = await ensureWorktree(repo, 'fix/thing', target, { base: 'main' });
  assert.ok(result.ok, result.detail);
  // Without the fetch-then-compare this would sit on the clone's stale main.
  assert.equal(await headOf(target), ahead);
});

test('a new branch starts from the local default when it is ahead of origin', async () => {
  const { root, repo } = await clonedRepo();
  const task = join(root, 'task');
  const ahead = await commit(repo, 'c.txt', 'committed here, not pushed yet');

  const target = join(task, worktreeDirName('reflow', 'fix/other'));
  const result = await ensureWorktree(repo, 'fix/other', target, { base: 'main' });
  assert.ok(result.ok, result.detail);
  assert.equal(await headOf(target), ahead);
});

test('a local branch behind origin is advanced to origin before checkout', async () => {
  const { root, origin, repo } = await clonedRepo();
  const task = join(root, 'task');

  // The branch exists on both sides, and origin has a commit this clone lacks.
  await run('git', ['-C', origin, 'checkout', '-q', '-b', 'fix/shared']);
  const first = await headOf(origin);
  await run('git', ['-C', repo, 'fetch', '-q', 'origin']);
  await run('git', ['-C', repo, 'branch', 'fix/shared', first]);
  const pushed = await commit(origin, 'd.txt', 'pushed from another machine');

  const target = join(task, worktreeDirName('reflow', 'fix/shared'));
  const result = await ensureWorktree(repo, 'fix/shared', target, {});
  assert.ok(result.ok, result.detail);
  assert.equal(await headOf(target), pushed);
});

test('local work on the branch is never discarded for origin', async () => {
  const { root, origin, repo } = await clonedRepo();
  const task = join(root, 'task');

  await run('git', ['-C', origin, 'checkout', '-q', '-b', 'fix/mine']);
  const first = await headOf(origin);
  await run('git', ['-C', repo, 'fetch', '-q', 'origin']);
  await run('git', ['-C', repo, 'checkout', '-q', '-b', 'fix/mine', first]);
  const mine = await commit(repo, 'e.txt', 'unpushed local work');
  await run('git', ['-C', repo, 'checkout', '-q', 'main']);
  // origin moves too, so the two have diverged.
  await commit(origin, 'f.txt', 'and origin moved as well');

  const target = join(task, worktreeDirName('reflow', 'fix/mine'));
  const result = await ensureWorktree(repo, 'fix/mine', target, {});
  assert.ok(result.ok, result.detail);
  assert.equal(await headOf(target), mine);
});
