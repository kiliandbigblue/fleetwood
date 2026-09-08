import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasDriftedOffBranch, worktreeDirName, worktreeShortName } from '../src/naming.ts';
import { repoSummary } from '../src/taskView.ts';
import type { TaskRepo } from '../src/task.ts';

test('a worktree directory is named for its repo and its branch, both', () => {
  assert.equal(
    worktreeDirName('reflow', 'feature/orders-drop-b2b-flag'),
    'reflow-orders-drop-b2b-flag',
  );
  // A stack is several branches of one repo, so the repo alone cannot name them.
  assert.notEqual(
    worktreeDirName('reflow', 'feature/orders-use-order-type'),
    worktreeDirName('reflow', 'feature/orders-dual-write-order-type'),
  );
});

test('a branch with no type prefix still names a directory', () => {
  assert.equal(worktreeDirName('fleetwood', 'readme-typo-hunt'), 'fleetwood-readme-typo-hunt');
});

test('a branch that slugifies to nothing leaves the repo name alone', () => {
  // Better a directory named after the repo than one ending in a bare dash.
  assert.equal(worktreeDirName('reflow', 'feature/'), 'reflow');
});

test('a stack layer is where it says it is, so it has not drifted', () => {
  assert.equal(
    hasDriftedOffBranch(
      'reflow-orders-drop-b2b-flag',
      'feature/orders-drop-b2b-flag',
      'feature/orders-use-order-type',
    ),
    false,
  );
});

test('a worktree switched to a branch its name does not claim has drifted', () => {
  assert.equal(
    hasDriftedOffBranch('reflow-orders-drop-b2b-flag', 'dev', 'feature/orders-use-order-type'),
    true,
  );
});

test('a worktree named after its repo alone is judged by the task branch', () => {
  // The old layout, which stays on disk and must not start reading as drift.
  assert.equal(hasDriftedOffBranch('graphy', 'feature/orders-page', 'feature/orders-page'), false);
  assert.equal(hasDriftedOffBranch('graphy', 'fix/something-else', 'feature/orders-page'), true);
});

test('a branch we could not read is not evidence of drift', () => {
  assert.equal(hasDriftedOffBranch('graphy', undefined, 'feature/orders-page'), false);
});

function repo(name: string, over: Partial<TaskRepo> = {}): TaskRepo {
  return { name, path: `/tasks/t/${name}`, dirty: 0, ...over };
}

test('a stacked task counts one repo and says how many worktrees of it', () => {
  const repos = [
    repo('reflow-orders-use-order-type', { repo: 'bigbluedisco/reflow', branch: 'feature/orders-use-order-type' }),
    repo('reflow-orders-dual-write-order-type', {
      repo: 'bigbluedisco/reflow',
      branch: 'feature/orders-dual-write-order-type',
    }),
    repo('reflow-orders-drop-b2b-flag', {
      repo: 'bigbluedisco/reflow',
      branch: 'feature/orders-drop-b2b-flag',
    }),
  ];
  // Not `3 repos`, which is what it said before and is simply wrong — and not
  // `2 off-branch`, because both of those layers are the work, not drift.
  assert.equal(repoSummary(repos, 'feature/orders-use-order-type'), '1 repo · 3 worktrees');
});

test('one worktree per repo reads exactly as it always did', () => {
  const repos = [
    repo('proto-flow-labels', { repo: 'bigbluedisco/proto', branch: 'fix/flow-labels' }),
    repo('graphy-flow-labels', { repo: 'bigbluedisco/graphy', branch: 'fix/flow-labels', dirty: 4 }),
  ];
  assert.equal(repoSummary(repos, 'fix/flow-labels'), '2 repos · 1 dirty');
});

test('real drift is still called out', () => {
  const repos = [
    repo('proto-flow-labels', { repo: 'bigbluedisco/proto', branch: 'dev' }),
    repo('graphy-flow-labels', { repo: 'bigbluedisco/graphy', branch: 'fix/flow-labels' }),
  ];
  assert.equal(repoSummary(repos, 'fix/flow-labels'), '2 repos · 1 off-branch');
});

test('a worktree name drops the branch slug it was built from', () => {
  assert.equal(
    worktreeShortName(
      'atlas-ui-receive-receive-item-into-rebin-or-mono-item',
      'feature/receive-receive-item-into-rebin-or-mono-item',
      'receive-receive-item-into-rebin-or-mono-item',
    ),
    'atlas-ui',
  );
});

test("a stack layer drops its own branch's slug, not the task's", () => {
  // The whole reason the branch is tried first: a layer's directory is named for
  // the layer, so stripping the task slug would strip nothing from exactly the
  // names that are longest.
  assert.equal(
    worktreeShortName('reflow-orders-drop-b2b-flag', 'feature/orders-drop-b2b-flag', 'orders-dual-write'),
    'reflow',
  );
});

test('the task slug is the fallback when the branch could not be read', () => {
  assert.equal(worktreeShortName('fleetwood-ui-refonte', undefined, 'ui-refonte'), 'fleetwood');
});

test('a name that claims no slug is left whole', () => {
  // A legacy worktree named after the repo alone, and a hand-renamed directory.
  assert.equal(worktreeShortName('fleetwood', 'feature/ui-refonte', 'ui-refonte'), 'fleetwood');
  assert.equal(worktreeShortName('scratch', 'feature/ui-refonte', 'ui-refonte'), 'scratch');
});

test('a name that is nothing but its slug keeps the name', () => {
  // Stripping would leave the row with no identifier at all.
  assert.equal(worktreeShortName('-ui-refonte', 'feature/ui-refonte', 'ui-refonte'), '-ui-refonte');
});
