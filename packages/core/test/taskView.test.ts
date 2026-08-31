import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFor, partitionAgents, prRepoTags, repoSummary } from '../src/taskView.ts';
import type { FleetAgent } from '../src/fleet.ts';
import type { Task, TaskRepo } from '../src/task.ts';
import type { TaskPr } from '../src/taskPrs.ts';

const task = {
  slug: 'flow-execution-labels',
  branch: 'fix/flow-execution-labels',
  dir: '/tasks/flow-execution-labels',
  type: 'fix',
  microservice: 'flow',
  summary: 'execution labels',
  createdAt: 0,
  repos: [
    { name: 'proto', path: '/tasks/flow-execution-labels/proto', branch: 'fix/flow-execution-labels', dirty: 0 },
    { name: 'graphy', path: '/tasks/flow-execution-labels/graphy', branch: 'fix/flow-execution-labels', dirty: 4 },
    { name: 'atlas', path: '/tasks/flow-execution-labels/atlas', branch: 'dev', dirty: 2 },
  ],
} satisfies Task;

/** Only `cwd` is read; the rest is here so the shape is a real agent. */
function agent(key: string, cwd?: string): FleetAgent {
  return { key, cwd, tool: 'claude', status: 'working', alive: true, forSeconds: 1, nested: false } as FleetAgent;
}

test('an agent at the task root belongs to the task, not to a repo', () => {
  const { taskLevel, byRepo } = partitionAgents(task, [agent('a', '/tasks/flow-execution-labels')]);
  assert.deepEqual(
    taskLevel.map((a) => a.key),
    ['a'],
  );
  assert.equal(byRepo.size, 0);
});

test('an agent inside a worktree is filed under that repo, at any depth', () => {
  const { taskLevel, byRepo } = partitionAgents(task, [
    agent('root', '/tasks/flow-execution-labels/proto'),
    agent('deep', '/tasks/flow-execution-labels/graphy/internal/pkg'),
  ]);
  assert.equal(taskLevel.length, 0);
  assert.deepEqual(byRepo.get('proto')?.map((a) => a.key), ['root']);
  assert.deepEqual(byRepo.get('graphy')?.map((a) => a.key), ['deep']);
});

test('a repo name that prefixes another is not swallowed by it', () => {
  // `/…/proto` must not claim `/…/proto-go`: matching on the prefix without the
  // separator is exactly how that happens.
  const withSibling: Task = {
    ...task,
    repos: [...task.repos, { name: 'proto-go', path: '/tasks/flow-execution-labels/proto-go', dirty: 0 }],
  };
  const { byRepo } = partitionAgents(withSibling, [agent('a', '/tasks/flow-execution-labels/proto-go/gen')]);
  assert.equal(byRepo.get('proto'), undefined);
  assert.deepEqual(byRepo.get('proto-go')?.map((a) => a.key), ['a']);
});

test('an agent with no cwd counts as task-level rather than being dropped', () => {
  const { taskLevel, byRepo } = partitionAgents(task, [agent('a')]);
  assert.deepEqual(taskLevel.map((a) => a.key), ['a']);
  assert.equal(byRepo.size, 0);
});

test('several agents in one repo keep their order under it', () => {
  const { byRepo } = partitionAgents(task, [
    agent('first', '/tasks/flow-execution-labels/proto'),
    agent('second', '/tasks/flow-execution-labels/proto/api'),
  ]);
  assert.deepEqual(byRepo.get('proto')?.map((a) => a.key), ['first', 'second']);
});

test('the summary counts repos, not changes — it stands in for the rows', () => {
  // graphy has 4 uncommitted changes and atlas 2; that is two dirty repos, which is
  // what you would open the rows to find out.
  assert.equal(repoSummary(task.repos, task.branch), '3 repos · 2 dirty · 1 off-branch');
});

test('a clean task on-branch says only how big it is', () => {
  const clean = task.repos.map((r) => ({ ...r, dirty: 0, branch: task.branch }));
  assert.equal(repoSummary(clean, task.branch), '3 repos');
  assert.equal(repoSummary(clean.slice(0, 1), task.branch), '1 repo');
});

test('an unread branch is not reported as drift', () => {
  // A worktree whose branch we could not read is not evidence of anything; only a
  // branch we read and which differs is.
  const unknown = [{ name: 'proto', path: '/x/proto', dirty: 0 }];
  assert.equal(repoSummary(unknown, task.branch), '1 repo');
});

test('a task with no repos yet still reads as a sentence', () => {
  assert.equal(repoSummary([], task.branch), '0 repos');
});

/**
 * The stack out of `orders-b2b-flag-migration`: one repo, two worktrees, and the
 * second layer based on the first rather than on `dev`.
 */
const helperLayer: TaskRepo = {
  name: 'reflow-orders-helper-order-type-b2b',
  path: '/t/reflow-orders-helper-order-type-b2b',
  repo: 'bigbluedisco/reflow',
  branch: 'fix/orders-helper-order-type-b2b',
  dirty: 0,
};
const upsertLayer: TaskRepo = {
  name: 'reflow-orders-upsert-b2b-order-type',
  path: '/t/reflow-orders-upsert-b2b-order-type',
  repo: 'bigbluedisco/reflow',
  branch: 'fix/orders-upsert-b2b-order-type',
  dirty: 2,
};

function pr(overrides: Partial<TaskPr>): TaskPr {
  return {
    repo: 'bigbluedisco/reflow',
    number: 1,
    title: 'x',
    url: 'https://example.invalid/1',
    updatedAt: '2026-01-01T00:00:00Z',
    isDraft: false,
    roles: ['mine'],
    branch: 'fix/orders-upsert-b2b-order-type',
    via: 'head',
    ...overrides,
  } as TaskPr;
}

test('a stacked layer takes its base from its own pull request, not the trunk', () => {
  const prs = [
    pr({ number: 10427, branch: helperLayer.branch, base: 'dev', repoName: helperLayer.name }),
    pr({
      number: 10428,
      branch: upsertLayer.branch,
      base: 'fix/orders-helper-order-type-b2b',
      repoName: upsertLayer.name,
    }),
  ];
  // The bottom layer is cut from the trunk and says so.
  assert.equal(baseFor(prs, helperLayer), 'dev');
  // The layer above names the one below — the fact no read of the graph supplies.
  assert.equal(baseFor(prs, upsertLayer), 'fix/orders-helper-order-type-b2b');
});

test('the worktree is matched too, so a namesake branch in another repo cannot answer', () => {
  // `fix/orders-use-order-type-over-b2b` exists in both reflow and graphy in this
  // migration, and each has its own pull request with its own base.
  const graphyLayer: TaskRepo = {
    ...upsertLayer,
    name: 'graphy-orders-use-order-type-over-b2b',
    branch: 'fix/shared-name',
  };
  const prs = [
    pr({ branch: 'fix/shared-name', base: 'dev', repoName: 'reflow-orders-use-order-type-over-b2b' }),
  ];
  assert.equal(baseFor(prs, graphyLayer), undefined);
});

test('only the branch a worktree is actually on can supply its base', () => {
  // `stack`, `history` and `task` name branches this worktree is not checked out
  // on, so their bases describe a different review than the one being opened.
  const prs = [
    pr({
      branch: upsertLayer.branch,
      base: 'fix/somewhere-else',
      via: 'stack',
      repoName: upsertLayer.name,
    }),
  ];
  assert.equal(baseFor(prs, upsertLayer), undefined);
});

test('no pull request, no base — the trunk decides instead', () => {
  assert.equal(baseFor(undefined, upsertLayer), undefined);
  assert.equal(baseFor([], upsertLayer), undefined);
  // A worktree with no branch at all (detached) cannot be matched on one.
  const detached: TaskRepo = { ...upsertLayer, branch: undefined };
  assert.equal(baseFor([pr({ base: 'dev', repoName: upsertLayer.name })], detached), undefined);
});

test('a task whose pull requests span repos tags each row with its repo', () => {
  const tags = prRepoTags([
    pr({ repo: 'bigbluedisco/reflow', number: 10427 }),
    pr({ repo: 'bigbluedisco/proto', number: 88 }),
  ]);
  assert.deepEqual(tags, {
    'bigbluedisco/reflow#10427': 'reflow',
    'bigbluedisco/proto#88': 'proto',
  });
});

test('a stack — several pull requests in one repo — gets no tags', () => {
  const tags = prRepoTags([
    pr({ repo: 'bigbluedisco/reflow', number: 10427 }),
    pr({ repo: 'bigbluedisco/reflow', number: 10428 }),
    pr({ repo: 'bigbluedisco/reflow', number: 10429 }),
  ]);
  assert.deepEqual(tags, {});
});

test('one pull request has nothing to be told apart from', () => {
  assert.deepEqual(prRepoTags([pr({})]), {});
  assert.deepEqual(prRepoTags([]), {});
});
