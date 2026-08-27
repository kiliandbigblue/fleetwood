import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBranch,
  canAdvance,
  confirmChoice,
  EMPTY_DRAFT,
  moveCursor,
  previewBranch,
  slugify,
  STEPS,
  toggleChoice,
  visibleChoices,
} from '../src/renderer/newTaskFlow.ts';

/*
 * The Enter/Tab rules, which are the whole feel of the flow. Driven here rather
 * than through a DOM because that is the only thing `newTaskFlow.ts` was split
 * out to allow — see its header.
 */

test('Enter with nothing toggled takes the row the cursor is on', () => {
  assert.deepEqual(confirmChoice([], ['atlas', 'graphy', 'proto'], 1), ['graphy']);
});

test('Enter takes the toggled set once there is one, cursor or no cursor', () => {
  // Standing on `proto` having toggled the other two: the set wins, and `proto`
  // is not silently added to it.
  assert.deepEqual(confirmChoice(['atlas', 'graphy'], ['atlas', 'graphy', 'proto'], 2), ['atlas', 'graphy']);
});

test('Enter on an empty list yields nothing rather than undefined', () => {
  assert.deepEqual(confirmChoice([], [], 0), []);
  // A filter that matches nothing leaves the cursor pointing past the end.
  assert.deepEqual(confirmChoice([], ['atlas'], 4), []);
});

test('Tab toggles both ways and keeps the order things were picked in', () => {
  let toggled = toggleChoice([], 'graphy');
  toggled = toggleChoice(toggled, 'atlas');
  assert.deepEqual(toggled, ['graphy', 'atlas']);
  assert.deepEqual(toggleChoice(toggled, 'graphy'), ['atlas']);
});

test('the cursor clamps at both ends and survives an empty list', () => {
  assert.equal(moveCursor(0, -1, 3), 0);
  assert.equal(moveCursor(2, 1, 3), 2);
  assert.equal(moveCursor(1, 1, 3), 2);
  assert.equal(moveCursor(2, 1, 0), 0);
});

test('a picked repo the filter excludes is kept on top, not hidden', () => {
  const repos = ['atlas', 'graphy', 'proto', 'proto-go'];
  // Having picked `atlas`, then typed `proto` looking for the next one.
  assert.deepEqual(visibleChoices(repos, 'proto', ['atlas']), ['atlas', 'proto', 'proto-go']);
  // A match that is already picked is listed once, in its own place.
  assert.deepEqual(visibleChoices(repos, 'proto', ['proto']), ['proto', 'proto-go']);
});

test('the filter never invents a repo that is not there', () => {
  assert.deepEqual(visibleChoices(['atlas'], '', ['gone']), ['atlas']);
});

test('only the goal may be left empty', () => {
  const draft = { ...EMPTY_DRAFT, repos: ['atlas'], microservice: 'flow', summary: 'labels' };
  assert.equal(canAdvance('repos', { ...draft, repos: [] }), false);
  assert.equal(canAdvance('repos', draft), true);
  assert.equal(canAdvance('microservice', { ...draft, microservice: '   ' }), false);
  assert.equal(canAdvance('summary', { ...draft, summary: '' }), false);
  assert.equal(canAdvance('goal', { ...draft, goal: '' }), true);
});

test('every step can render an answer for a draft it has not reached yet', () => {
  // The scrollback maps over the steps behind the cursor, and going back leaves
  // later ones half-filled; none of them may throw on that.
  for (const step of STEPS) assert.equal(typeof step.answer(EMPTY_DRAFT), 'string');
});

test('the preview stays visibly unfinished until it is finished', () => {
  const draft = { ...EMPTY_DRAFT, type: 'fix' };
  assert.equal(previewBranch(draft), 'fix/…');
  assert.equal(previewBranch({ ...draft, microservice: 'flow' }), 'fix/flow-…');
  assert.equal(previewBranch({ ...draft, microservice: 'flow', summary: 'execution labels' }), 'fix/flow-execution-labels');
});

/*
 * The renderer used to keep its own copy of the branch naming, because reaching
 * core's meant reaching `task.ts` and its `node:fs` import. It imports the real
 * one from `core/naming.ts` now, so what is left to check is the convention: a
 * branch name `fw` and git will both accept, out of whatever was typed.
 */
test('every answer the flow accepts builds a usable branch name', () => {
  const cases: Array<[string, string, string]> = [
    ['feature', 'flow', 'execution labels'],
    ['fix', 'UI', 'New task from ⌘K'],
    ['chore', 'storage', '  spaces  and---dashes  '],
    ['', '', ''],
    ['feature', 'café', 'naïve résumé'],
    ['feature', 'flow', 'a summary long enough to be cut off by the sixty character limit'],
    ['Feature/slash', 'a_b.c', 'v1.2.3'],
  ];
  for (const [type, microservice, summary] of cases) {
    // The flow and core are the same function now — this is left as a check on
    // the convention itself rather than on two copies agreeing.
    assert.match(
      buildBranch(type, microservice, summary),
      /^[a-z0-9-]+\/[a-z0-9-]*$/,
      `branch for ${JSON.stringify([type, microservice, summary])}`,
    );
    assert.equal(slugify(summary), slugify(slugify(summary)));
  }
});
