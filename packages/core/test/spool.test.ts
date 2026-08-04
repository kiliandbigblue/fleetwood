import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneStates } from '../src/spool.ts';
import type { AgentState } from '../src/events.ts';

function state(over: Partial<AgentState> & { key: string }): AgentState {
  return {
    tool: 'claude',
    status: 'idle',
    provenance: 'hook',
    since: 0,
    lastEventAt: 0,
    lastEvent: 'Stop',
    turns: 1,
    toolCalls: 0,
    errorCount: 0,
    subagents: 0,
    ...over,
  };
}

const NOW = 10_000;

test('a finished agent is kept briefly, then dropped', () => {
  const states = new Map<string, AgentState>([
    ['a', state({ key: 'a', status: 'gone', lastEventAt: NOW - 60 })],
    ['b', state({ key: 'b', status: 'gone', lastEventAt: NOW - 600 })],
  ]);
  assert.equal(pruneStates(states, NOW), 1);
  assert.deepEqual([...states.keys()], ['a'], 'the recently-ended one still shows');
});

test('a long-silent agent is dropped whatever its last known status', () => {
  // This is the leak that made a dead cursor-agent sit in "orphaned" forever:
  // nothing ever transitions such a state, so only age can retire it.
  const states = new Map<string, AgentState>([
    ['stuck', state({ key: 'stuck', status: 'working', lastEventAt: NOW - 7_200 })],
    ['live', state({ key: 'live', status: 'working', lastEventAt: NOW - 30 })],
  ]);
  assert.equal(pruneStates(states, NOW), 1);
  assert.deepEqual([...states.keys()], ['live']);
});

test('active agents are never pruned', () => {
  const states = new Map<string, AgentState>([
    ['a', state({ key: 'a', status: 'working', lastEventAt: NOW })],
    ['b', state({ key: 'b', status: 'blocked_permission', lastEventAt: NOW - 120 })],
    ['c', state({ key: 'c', status: 'idle', lastEventAt: NOW - 300 })],
  ]);
  assert.equal(pruneStates(states, NOW), 0);
  assert.equal(states.size, 3);
});

test('a blocked agent is not retired while it is still waiting on you', () => {
  // Someone can leave a permission prompt unanswered over lunch; dropping it
  // would remove the one row they most need to come back to.
  const states = new Map<string, AgentState>([
    ['waiting', state({ key: 'waiting', status: 'blocked_permission', lastEventAt: NOW - 3_000 })],
  ]);
  assert.equal(pruneStates(states, NOW), 0);
  assert.equal(states.size, 1);
});

test('pruning an empty store is a no-op', () => {
  const states = new Map<string, AgentState>();
  assert.equal(pruneStates(states, NOW), 0);
});
