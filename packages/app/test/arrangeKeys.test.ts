import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeIntent, inertMove } from '../src/renderer/arrangeKeys.ts';

/*
 * What the arranging keys mean, and what they say when they cannot act. The
 * edges are the pins: a tier's top is not the panel's top.
 */

const order = ['+10-pinned', '10-atlas', '20-graphy', 'reflow'];

test('the shifted j and k move the card, the bare ones stay focus keys', () => {
  assert.deepEqual(arrangeIntent('J'), { kind: 'move', direction: 'down' });
  assert.deepEqual(arrangeIntent('K'), { kind: 'move', direction: 'up' });
  assert.equal(arrangeIntent('j'), undefined);
  assert.equal(arrangeIntent('k'), undefined);
});

test('t, b and p are the top, the bottom and the pin', () => {
  assert.deepEqual(arrangeIntent('t'), { kind: 'move', direction: 'top' });
  assert.deepEqual(arrangeIntent('b'), { kind: 'move', direction: 'bottom' });
  assert.deepEqual(arrangeIntent('p'), { kind: 'pin' });
  assert.equal(arrangeIntent('x'), undefined);
});

test('a card that will move has nothing to explain', () => {
  assert.equal(inertMove(order, '20-graphy', 'up'), undefined);
  assert.equal(inertMove(order, '20-graphy', 'bottom'), undefined);
});

test('the first card under the pins is already as high as it goes', () => {
  assert.equal(inertMove(order, '10-atlas', 'top'), 'atlas is already first below the pins');
  assert.equal(inertMove(order, '10-atlas', 'up'), 'atlas is already first below the pins');
});

test('a lone pin is both ends of its own tier', () => {
  assert.equal(inertMove(order, '+10-pinned', 'top'), 'pinned is already first of the pinned');
  assert.equal(inertMove(order, '+10-pinned', 'down'), 'pinned is already last of the pinned');
});

test('the last card says it is last', () => {
  assert.equal(inertMove(order, 'reflow', 'bottom'), 'reflow is already last in the list');
});
