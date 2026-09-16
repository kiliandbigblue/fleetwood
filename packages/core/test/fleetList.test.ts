import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkSession } from '../src/fleetList.ts';

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
