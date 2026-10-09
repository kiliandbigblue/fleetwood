import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAgent } from '../src/nextAgent.ts';
import type { FleetSession } from '../src/fleet.ts';
import type { AgentStatus } from '../src/types.ts';

function session(name: string, ...agents: [string, AgentStatus][]): FleetSession {
  return { name, agents: agents.map(([pane, status]) => ({ pane, status })) } as unknown as FleetSession;
}

// `gone` agents are not stops; neither is a hidden session.
const fleet = [
  session('20-atlas', ['%5', 'idle'], ['%6', 'blocked_permission']),
  session('10-fleetwood', ['%1', 'working'], ['%1', 'idle'], ['%2', 'blocked_permission']),
  session('-30-hidden', ['%9', 'blocked_permission']),
  session('HOME', ['%7', 'gone']),
];

test('next walks the fleet in slot order, one stop per pane, and wraps', () => {
  const walk = (from: string | undefined) => nextAgent(fleet, from, false)?.agent.pane;
  assert.equal(walk(undefined), '%1');
  assert.equal(walk('%1'), '%2');
  assert.equal(walk('%2'), '%5');
  assert.equal(walk('%6'), '%1');
  // A plain shell starts from the top.
  assert.equal(walk('%42'), '%1');
});

test('next blocked skips everything else and never lands on a hidden session', () => {
  const walk = (from: string | undefined) => nextAgent(fleet, from, true)?.agent.pane;
  assert.equal(walk(undefined), '%2');
  assert.equal(walk('%2'), '%6');
  assert.equal(walk('%6'), '%2');
  assert.equal(walk('%5'), '%6');
});

test('nothing to go to when you are already on the only blocked agent', () => {
  assert.equal(nextAgent([session('a', ['%1', 'blocked_permission'], ['%2', 'idle'])], '%1', true), undefined);
  assert.equal(nextAgent([], undefined, false), undefined);
});
