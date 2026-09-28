import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FleetAgent, TaskPr } from '@fleetwood/core';
import {
  agentLabel,
  byUrgency,
  liveSeverity,
  needsYouLabel,
  prHeadline,
  stepIndex,
} from '../src/renderer/fleetSignals.ts';

const agent = (status: FleetAgent['status'], activity?: string): FleetAgent =>
  ({ status, activity }) as FleetAgent;

const pr = (fields: Partial<TaskPr>): TaskPr => fields as TaskPr;

test('a permission prompt leads over work, and work over rest', () => {
  assert.equal(liveSeverity([agent('working'), agent('idle'), agent('blocked_permission')]), 'danger');
  assert.equal(liveSeverity([agent('idle'), agent('working')]), 'ok');
  assert.equal(liveSeverity([agent('idle')]), 'quiet');
});

test('agents are listed most urgent first, and stably', () => {
  const idleA = agent('idle', 'a');
  const idleB = agent('idle', 'b');
  const blocked = agent('blocked_permission');
  assert.deepEqual(byUrgency([idleA, blocked, idleB]), [blocked, idleA, idleB]);
});

test('the head only speaks when an agent is stopped on you', () => {
  assert.equal(needsYouLabel([agent('working')]), undefined);
  assert.equal(needsYouLabel([agent('idle')]), undefined);
  assert.equal(needsYouLabel([agent('blocked_permission'), agent('blocked_permission')]), '2 need permission');
});

test("a finished agent's last words follow its status rather than replacing it", () => {
  assert.equal(agentLabel(agent('idle', 'done')), 'idle · done');
  assert.equal(agentLabel(agent('working', 'Bash: pnpm test')), 'Bash: pnpm test');
  assert.equal(agentLabel(agent('idle')), 'idle');
});

test('a folded card names its most pressing pull request state', () => {
  assert.equal(
    prHeadline([pr({ reviewDecision: 'APPROVED' }), pr({ reviewDecision: 'CHANGES_REQUESTED' })]),
    '1 changes requested',
  );
  assert.equal(prHeadline([pr({ checks: 'failing' }), pr({})]), '1 failing');
  assert.equal(prHeadline([pr({}), pr({})]), '2 open');
  assert.equal(prHeadline([pr({ state: 'MERGED' })]), 'all merged');
  assert.equal(prHeadline([]), undefined);
});

test('j and k hold at the ends and enter from the right side', () => {
  assert.equal(stepIndex(-1, 3, 1), 0);
  assert.equal(stepIndex(-1, 3, -1), 2);
  assert.equal(stepIndex(2, 3, 1), 2);
  assert.equal(stepIndex(0, 3, -1), 0);
  assert.equal(stepIndex(-1, 0, 1), -1);
});
