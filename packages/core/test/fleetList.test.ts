import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dormantWorkspaces, isWorkSession, markWorkspaces } from '../src/fleetList.ts';
import type { SessionMeta } from '../src/types.ts';

const at = (path: string, meta: SessionMeta = {}): { path: string; meta: SessionMeta } => ({ path, meta });

test('the fleet list is the work fleetwood set up', () => {
  assert.equal(isWorkSession({ kind: 'task', task: 'ui-hide-non-task-sessions' }), true);
  assert.equal(isWorkSession({ kind: 'pr', pr: 'bigbluedisco/atlas#3671' }), true);
});

test('a session fleetwood never created is not in it', () => {
  // The shell in `~`, and the one spawned to try a command: tmux has them, the
  // panel is not about them.
  assert.equal(isWorkSession({}), false);
  assert.equal(isWorkSession({ kind: 'scratch' }), false);
  // A project opened from the palette is a terminal in a repo — it still opens,
  // and the palette is still the way back to it.
  assert.equal(isWorkSession({ kind: 'project', repo: 'bigbluedisco/atlas' }), false);
});

test('a task session qualifies on @fw_task alone', () => {
  // Stamped before `@fw_kind` existed, or by hand — the `@fw_*` options are
  // meant to be settable with plain tmux. Dropping one of these would look like
  // a session that died.
  assert.equal(isWorkSession({ task: 'ui-hide-non-task-sessions' }), true);
});

test('a session rooted at a workspace is in the list', () => {
  const [os, atlas] = markWorkspaces(
    [
      at('/Users/me/projects/os'),
      at('/Users/me/projects/atlas'),
    ],
    ['/Users/me/projects/os/'],
  );
  assert.equal(os?.meta.kind, 'workspace');
  assert.equal(isWorkSession(os?.meta ?? {}), true);
  // Every other directory is still a terminal you opened.
  assert.equal(atlas?.meta.kind, undefined);
});

test('a session that says what it is keeps its kind in a workspace', () => {
  const [pr, task] = markWorkspaces(
    [
      at('/Users/me/projects/os', { kind: 'pr' }),
      at('/Users/me/projects/os', { task: 'os-main' }),
    ],
    ['/Users/me/projects/os'],
  );
  assert.equal(pr?.meta.kind, 'pr');
  assert.equal(task?.meta.kind, undefined);
});

test('a workspace with no session is offered to start', () => {
  assert.deepEqual(
    dormantWorkspaces(
      [{ path: '/Users/me/projects/os' }],
      ['/Users/me/projects/os/', '/Users/me/projects/ops'],
    ),
    ['/Users/me/projects/ops'],
  );
});
