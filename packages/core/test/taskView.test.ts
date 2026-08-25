import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionAgents, repoSummary } from '../src/taskView.ts';
import type { FleetAgent } from '../src/fleet.ts';
import type { Task } from '../src/task.ts';

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
