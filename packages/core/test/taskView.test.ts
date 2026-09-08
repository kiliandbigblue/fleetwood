import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseFor,
  groupPrStacks,
  partitionAgents,
  prRepoTags,
  prSummary,
  repoSummary,
  worstState,
} from '../src/taskView.ts';
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

/** A clean worktree, for the severity cases below. */
function repo(dirty: number): TaskRepo {
  return { ...upsertLayer, dirty };
}

test('a blocked agent outranks everything else on the card', () => {
  // It is the only state here that is *waiting* on you and getting nothing done
  // in the meantime, so it wins even against a card that is otherwise fine.
  assert.equal(worstState([repo(4)], [pr({ reviewDecision: 'APPROVED' })], true), 'danger');
});

test('work that has come back outranks work you have not committed', () => {
  assert.equal(worstState([repo(4)], [pr({ reviewDecision: 'CHANGES_REQUESTED' })], false), 'danger');
  assert.equal(worstState([repo(4)], [pr({ checks: 'failing' })], false), 'danger');
});

test('uncommitted changes outrank an approval', () => {
  // Yours to lose, against a merge you have merely not got round to.
  assert.equal(worstState([repo(2)], [pr({ reviewDecision: 'APPROVED' })], false), 'warn');
});

test('an approval is the quietest thing worth a stripe', () => {
  assert.equal(worstState([repo(0)], [pr({ reviewDecision: 'APPROVED' })], false), 'ok');
});

test('a working agent lifts a quiet card to the same accent its row already wears', () => {
  // Without this, the title mark stayed `quiet` while the agent row alone was live.
  assert.equal(worstState([repo(0)], [], false, [{ status: 'working' }]), 'ok');
  assert.equal(worstState([repo(0)], [], false, [{ status: 'compacting' }]), 'ok');
  assert.equal(worstState([repo(0)], [], false, [{ status: 'idle' }]), 'quiet');
});

test('a live agent does not outrank dirty work or a blocked session', () => {
  assert.equal(worstState([repo(2)], [], false, [{ status: 'working' }]), 'warn');
  assert.equal(worstState([repo(0)], [], true, [{ status: 'working' }]), 'danger');
});

test('a task with nothing to say gets no stripe', () => {
  assert.equal(worstState([repo(0)], [], false), 'quiet');
  assert.equal(worstState([], [], false), 'quiet');
});

test('pull requests still being searched for contribute nothing either way', () => {
  // `undefined` is the first `gh` search being out, which is not the claim that
  // this task has no pull requests — so it neither raises nor confirms a state.
  assert.equal(worstState([repo(0)], undefined, false), 'quiet');
  assert.equal(worstState([repo(3)], undefined, false), 'warn');
  assert.equal(worstState([repo(0)], undefined, true), 'danger');
});

test('a draft under review is not treated as reviewed', () => {
  // The row shows `draft` alone for the same reason: nobody has been asked yet.
  assert.equal(worstState([repo(0)], [pr({ isDraft: true, reviewDecision: 'REVIEW_REQUIRED' })], false), 'quiet');
});
/*
 * The three-layer stack, as the panel receives it: bottom first, each layer based
 * on the branch of the one below, and each holding more commits than that one.
 */
const bottom = pr({ number: 10410, branch: 'feature/orders-dual-write', base: 'dev', ahead: 6 });
const middle = pr({
  number: 10420,
  branch: 'feature/orders-use-order-type',
  base: 'feature/orders-dual-write',
  ahead: 9,
  via: 'stack',
});
const top = pr({
  number: 10430,
  branch: 'feature/orders-b2b-flag',
  base: 'feature/orders-use-order-type',
  ahead: 14,
  via: 'stack',
});

/** `#number` per row, so a layout assertion reads like the list it describes. */
function shape(rows: ReturnType<typeof groupPrStacks<TaskPr>>): string[] {
  return rows.map(
    (row) => `${'  '.repeat(row.depth)}#${row.pr.number} ${row.rung}/${row.of}` +
      (row.waitingOn === undefined ? '' : ` waiting on #${row.waitingOn}`),
  );
}

test('a pull request whose base is another one\'s branch sits on top of it', () => {
  const rows = groupPrStacks([bottom, middle, top]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2]);
  assert.deepEqual(rows.map((row) => row.rung), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.of), [3, 3, 3]);
});

test('a base that is the trunk starts no stack, because no pull request is on it', () => {
  const rows = groupPrStacks([
    pr({ number: 1, branch: 'fix/one', base: 'dev' }),
    pr({ number: 2, branch: 'fix/two', base: 'dev' }),
  ]);
  assert.deepEqual(rows.map((row) => row.of), [1, 1]);
  assert.deepEqual(rows.map((row) => row.waitingOn), [undefined, undefined]);
});

test('a release pull request from dev does not adopt every branch cut from dev', () => {
  // `dev` open against `main` is the one case where a trunk is a head branch, and
  // without the veto every branch based on `dev` would be read as sitting on it.
  const release = pr({ number: 99, branch: 'dev', base: 'main' });
  const rows = groupPrStacks([release, pr({ number: 1, branch: 'fix/one', base: 'dev' })]);
  assert.deepEqual(rows.map((row) => row.of), [1, 1]);
});

test('a base naming a branch in another repo links to nothing', () => {
  const rows = groupPrStacks([
    pr({ repo: 'bigbluedisco/reflow', number: 1, branch: 'feature/shared-name' }),
    pr({ repo: 'bigbluedisco/proto', number: 2, branch: 'feature/other', base: 'feature/shared-name' }),
  ]);
  assert.deepEqual(rows.map((row) => row.of), [1, 1]);
});

test('a layer whose parent has already merged is a bottom layer rather than an orphan', () => {
  // The search only returns open pull requests, so a merged base is simply absent —
  // and the layer above it is now the bottom of what is left.
  const rows = groupPrStacks([middle, top]);
  assert.deepEqual(shape(rows), ['#10420 1/2', '  #10430 2/2 waiting on #10420']);
});

test('two pull requests on one base fork the stack instead of forming a line', () => {
  const forkA = pr({ number: 10421, branch: 'feature/a', base: bottom.branch, ahead: 8 });
  const forkB = pr({ number: 10422, branch: 'feature/b', base: bottom.branch, ahead: 9 });
  const rows = groupPrStacks([bottom, forkA, forkB]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 1]);
  // Rung is position in the printed order, which is why both siblings are not `2`.
  assert.deepEqual(rows.map((row) => row.rung), [1, 2, 3]);
});

test('a base pointing back into the stack is cut rather than walked forever', () => {
  const a = pr({ number: 1, branch: 'feature/a', base: 'feature/b' });
  const b = pr({ number: 2, branch: 'feature/b', base: 'feature/a' });
  const rows = groupPrStacks([a, b]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.of), [2, 2]);
});

test('a pull request with no base stands alone, and one with no branch holds nothing up', () => {
  // The two gaps are not symmetric. No base means nothing was said about what this
  // one sits on; no branch means nothing can sit on *it*, since a layer is found by
  // the branch its base names.
  const noBase = groupPrStacks([
    pr({ number: 1, branch: 'feature/a', base: undefined }),
    pr({ number: 2, branch: 'feature/b', base: undefined }),
  ]);
  assert.deepEqual(noBase.map((row) => row.of), [1, 1]);

  const noBranch = groupPrStacks([
    pr({ number: 1, branch: undefined, base: 'dev' }),
    pr({ number: 2, branch: 'feature/b', base: 'feature/a' }),
  ]);
  assert.deepEqual(noBranch.map((row) => row.of), [1, 1]);
});

test('a stack is emitted where its earliest member sat, and nothing comes between its layers', () => {
  // The PR tab orders by recency, so a stack's layers arrive scattered. The stack
  // keeps the slot of whichever of them came first rather than being hoisted.
  const loose = pr({ number: 500, branch: 'fix/unrelated', base: 'dev' });
  const other = pr({ number: 600, branch: 'fix/also-unrelated', base: 'dev' });
  const rows = groupPrStacks([loose, middle, other, top, bottom]);
  assert.deepEqual(
    rows.map((row) => row.pr.number),
    [500, 10410, 10420, 10430, 600],
  );
});

test('a layer counted against the whole search still says which rung it is when the list around it is filtered', () => {
  // The PR tab splits one stack across `mine` and `needs my review`; each section
  // has to describe the stack it is a part of, not the fragment it can see.
  const rows = groupPrStacks([top], [bottom, middle, top]);
  assert.deepEqual(shape(rows), ['    #10430 3/3 waiting on #10420']);
});

test('a layer holding fewer commits than its base is not believed to sit on it', () => {
  const shallow = pr({ number: 10431, branch: 'feature/shallow', base: bottom.branch, ahead: 3 });
  const rows = groupPrStacks([bottom, shallow]);
  assert.deepEqual(rows.map((row) => row.of), [1, 1]);
});

test('a layer waiting on an open pull request names it, and a bottom layer names nothing', () => {
  const rows = groupPrStacks([bottom, middle, top]);
  assert.deepEqual(rows.map((row) => row.waitingOn), [undefined, 10410, 10420]);
});

test('every pull request handed in comes back exactly once', () => {
  const all = [bottom, middle, top, pr({ number: 1, branch: 'fix/loose', base: 'dev' })];
  const rows = groupPrStacks(all);
  assert.equal(rows.length, all.length);
  assert.equal(new Set(rows.map((row) => row.pr.number)).size, all.length);
});

test('the summary names the stack, and both of them when a task has two', () => {
  assert.equal(prSummary([bottom, middle, top]), '3 open · stack of 3');
  const pair = [
    pr({ number: 20, branch: 'fix/lower', base: 'dev', ahead: 2 }),
    pr({ number: 21, branch: 'fix/upper', base: 'fix/lower', ahead: 4 }),
  ];
  assert.equal(prSummary([bottom, middle, top, ...pair]), '5 open · stacks of 3, 2');
  // A lone pull request is not a stack, so nothing is said about the shape.
  assert.equal(prSummary([pr({ number: 1, base: 'dev' })]), '1 open');
});
