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
