import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeIntent, inertMove } from '../src/renderer/arrangeKeys.ts';

/*
 * What the arranging keys mean, and what they say when they cannot act. The
 * edges are the group's: a move never leaves the plan, or Other, it is drawn in.
 */

const order = ['10-atlas', '20-graphy', 'reflow'];

test('the shifted j and k move the card, the bare ones stay focus keys', () => {
  assert.deepEqual(arrangeIntent('J'), { kind: 'move', direction: 'down' });
  assert.deepEqual(arrangeIntent('K'), { kind: 'move', direction: 'up' });
  assert.equal(arrangeIntent('j'), undefined);
  assert.equal(arrangeIntent('k'), undefined);
});

test('t and b are the top and the bottom, and p is no longer a pin', () => {
  assert.deepEqual(arrangeIntent('t'), { kind: 'move', direction: 'top' });
  assert.deepEqual(arrangeIntent('b'), { kind: 'move', direction: 'bottom' });
  assert.equal(arrangeIntent('p'), undefined);
  assert.equal(arrangeIntent('x'), undefined);
});

test('a card that will move has nothing to explain', () => {
  assert.equal(inertMove(order, '20-graphy', 'up'), undefined);
  assert.equal(inertMove(order, '20-graphy', 'bottom'), undefined);
});

test('a card at the end of its group says so, naming the group when there is one', () => {
  assert.equal(inertMove(order, '10-atlas', 'top', 'Stock Transfers'), 'atlas is already first in Stock Transfers');
  assert.equal(inertMove(order, 'reflow', 'down', 'Other'), 'reflow is already last in Other');
  // No plans, no groups: the list is the one thing there is to be at the end of.
  assert.equal(inertMove(order, '10-atlas', 'up'), 'atlas is already first in the list');
  assert.equal(inertMove(order, 'reflow', 'bottom'), 'reflow is already last in the list');
});
