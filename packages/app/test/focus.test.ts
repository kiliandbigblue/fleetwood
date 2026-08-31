import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FleetSession, Task } from '@fleetwood/core';
import { resolveFocus } from '../src/renderer/focus.ts';

/*
 * The pane holds a slug, not a task — see `focus.ts`. What that buys is a fresh
 * task on every snapshot; what it costs is one case that cannot be clicked into
 * existence, which is the task being archived while you are looking at it.
 */

const task = (slug: string, session?: string): Task =>
  ({ slug, branch: `feature/${slug}`, dir: `/tasks/${slug}`, repos: [], session }) as Task;

const session = (name: string): FleetSession => ({ name }) as FleetSession;

test('no slug is no focus', () => {
  assert.equal(resolveFocus([task('orders')], [], undefined), undefined);
});

test('a live task comes back with the session it is running in', () => {
  const found = resolveFocus([task('orders', '10-orders')], [session('10-orders')], 'orders');
  assert.equal(found?.task.slug, 'orders');
  assert.equal(found?.session?.name, '10-orders');
});

test('a dormant task comes back without one, which is a state and not a miss', () => {
  const found = resolveFocus([task('orders')], [session('10-other')], 'orders');
  assert.equal(found?.task.slug, 'orders');
  assert.equal(found?.session, undefined);
});

test('a session that has gone leaves the task focused, not the pane empty', () => {
  // `fw kill` in the terminal beside the panel: the task is still on disk, so the
  // pane stays and redraws dormant.
  const found = resolveFocus([task('orders', '10-orders')], [], 'orders');
  assert.equal(found?.task.slug, 'orders');
  assert.equal(found?.session, undefined);
});

test('a task archived under you resolves to nothing, so the pane can fall back', () => {
  assert.equal(resolveFocus([task('other')], [], 'orders'), undefined);
  assert.equal(resolveFocus(undefined, [], 'orders'), undefined);
});
