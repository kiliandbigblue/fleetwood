import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_LABEL, prStatus, repoStatus, taskStatus } from '../src/taskStatus.ts';
import { hasCommitEntry } from '../src/worktree.ts';
import type { TaskRepo } from '../src/task.ts';
import type { TaskPr } from '../src/taskPrs.ts';

function repo(name: string, fields: Partial<TaskRepo> = {}): TaskRepo {
  return { name, path: `/tasks/t/${name}`, branch: 'feature/t', dirty: 0, ...fields };
}

function pr(repoName: string | undefined, fields: Partial<TaskPr> = {}): TaskPr {
  return {
    repo: 'bigbluedisco/atlas',
    number: 1,
    title: 'feature/t',
    url: 'https://example.invalid',
    updatedAt: '2026-01-01T00:00:00Z',
    isDraft: false,
    roles: [],
    branch: 'feature/t',
    via: 'head',
    repoName,
    ...fields,
  };
}

// --- one pull request ------------------------------------------------------

test('a merged pull request is done, whatever else it says', () => {
  assert.equal(prStatus({ state: 'MERGED', isDraft: false }), 'done');
  assert.equal(prStatus({ state: 'MERGED', isDraft: true }), 'done');
});

test('draft is the line between wip and in review, not the review decision', () => {
  assert.equal(prStatus({ state: 'OPEN', isDraft: true }), 'wip');
  assert.equal(prStatus({ state: 'OPEN', isDraft: false }), 'in-review');
});

test('a pull request with no state came from a search, and every search is open-only', () => {
  assert.equal(prStatus({ isDraft: false }), 'in-review');
});

// --- one worktree, no pull request ----------------------------------------

test('clean, level with the trunk and never committed to is a task nobody started', () => {
  assert.equal(repoStatus({ dirty: 0, ahead: 0, everCommitted: false }), 'not-started');
});

test('uncommitted work is wip even with nothing pushed', () => {
  assert.equal(repoStatus({ dirty: 3, ahead: 0, everCommitted: false }), 'wip');
});

test('commits of its own are wip', () => {
  assert.equal(repoStatus({ dirty: 0, ahead: 2, everCommitted: true }), 'wip');
});

/* The case the whole change exists for: landed straight on `main`, no PR. */
test('level with the trunk but committed to at some point is work the trunk swallowed', () => {
  assert.equal(repoStatus({ dirty: 0, ahead: 0, everCommitted: true }), 'done');
});

test('no trunk to compare against never reaches done', () => {
  assert.equal(repoStatus({ dirty: 0, ahead: undefined, everCommitted: true }), 'wip');
  assert.equal(repoStatus({ dirty: 0, ahead: undefined, everCommitted: false }), 'not-started');
});

// --- the whole task --------------------------------------------------------

test('every pull request merged is a finished task', () => {
  const status = taskStatus(
    [repo('atlas'), repo('proto')],
    [pr('atlas', { state: 'MERGED' }), pr('proto', { state: 'MERGED', number: 2 })],
  );
  assert.equal(status, 'done');
});

test('every pull request up and out of draft is in review', () => {
  const status = taskStatus(
    [repo('atlas'), repo('proto')],
    [pr('atlas'), pr('proto', { number: 2, reviewDecision: 'CHANGES_REQUESTED' })],
  );
  assert.equal(status, 'in-review');
});

test('one draft among them drags the task back to wip', () => {
  const status = taskStatus(
    [repo('atlas'), repo('proto')],
    [pr('atlas', { state: 'MERGED' }), pr('proto', { number: 2, isDraft: true })],
  );
  assert.equal(status, 'wip');
});

/* The old mark ranked uncommitted work above an approval; this one does not. */
test('a dirty worktree does not drag a reviewed pull request backwards', () => {
  assert.equal(taskStatus([repo('atlas', { dirty: 5, ahead: 3 })], [pr('atlas')]), 'in-review');
});

test('a repo nobody touched does not hold a merged task open', () => {
  const status = taskStatus(
    [repo('atlas', { ahead: 0, everCommitted: true }), repo('graphy', { ahead: 0, everCommitted: false })],
    [pr('atlas', { state: 'MERGED' })],
  );
  assert.equal(status, 'done');
});

test('a task where nothing has moved anywhere is not started', () => {
  const status = taskStatus([repo('atlas', { ahead: 0 }), repo('graphy', { ahead: 0 })], []);
  assert.equal(status, 'not-started');
});

test('a task with no repos at all is not started', () => {
  assert.equal(taskStatus([], []), 'not-started');
});

/* The local mode: land straight on main, never open a pull request. */
test('with no pull requests the worktrees answer on their own', () => {
  assert.equal(taskStatus([repo('fleetwood', { ahead: 0, everCommitted: true })], []), 'done');
  assert.equal(taskStatus([repo('fleetwood', { ahead: 1, everCommitted: true })], []), 'wip');
});

test('the first fetch still being out is answered from the worktrees, and settles upward', () => {
  const repos = [repo('atlas', { ahead: 2, everCommitted: true })];
  assert.equal(taskStatus(repos, undefined), 'wip');
  assert.equal(taskStatus(repos, [pr('atlas')]), 'in-review');
});

test("a pull request on the task's branch in a repo the folder does not hold still counts", () => {
  const status = taskStatus(
    [repo('atlas', { ahead: 0, everCommitted: true })],
    [pr(undefined, { via: 'task', isDraft: true })],
  );
  assert.equal(status, 'wip');
});

test('every rung has a label', () => {
  assert.deepEqual(Object.values(STATUS_LABEL), ['not started', 'wip', 'in review', 'done']);
});

// --- the reflog read the local rules stand on ------------------------------

test('a branch created and never committed to reads as untouched', () => {
  assert.equal(hasCommitEntry('branch: Created from HEAD\n'), false);
});

test('a commit on the branch is remembered after the work lands', () => {
  const log = ['reset: moving to origin/main', 'commit: wire up the dot', 'branch: Created from HEAD'].join('\n');
  assert.equal(hasCommitEntry(log), true);
});

test('amended and initial commits count too', () => {
  assert.equal(hasCommitEntry('commit (amend): fix the comment'), true);
  assert.equal(hasCommitEntry('commit (initial): first'), true);
});

test('a merge or a rebase is not a commit made here', () => {
  assert.equal(hasCommitEntry('merge feature/x: Fast-forward\nrebase (finish): refs/heads/main'), false);
});
