import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planKillAgent } from '../src/actions.ts';
import type { AgentTarget } from '../src/actions.ts';
import { markGone } from '../src/spool.ts';
import type { AgentState } from '../src/events.ts';

/**
 * The pids below are the shape reconciliation produces, and the point of every
 * case is the same: each agent has a plausible-looking second pid that belongs to
 * a *different* agent, and signalling that one would close the wrong session.
 */

test('a top-level agent is killed by the pid it reported', () => {
  const agent: AgentTarget = { tool: 'claude', pane: '%3', hookPid: 78881, pid: 78881 };
  assert.deepEqual(planKillAgent(agent).candidates, [78881]);
});

test('an agent that never sent a hook falls back to the pane match', () => {
  // provenance 'process': found in `ps`, so the only pid we have is the pane's.
  const agent: AgentTarget = { tool: 'cursor', pane: '%7', pid: 4321 };
  assert.deepEqual(planKillAgent(agent).candidates, [4321]);
});

test('two agents in one pane are told apart by their own pids', () => {
  // Both rows carry the same pane match — the pane's outermost agent — so the
  // reported pid has to win, or closing either would close the first one.
  const first: AgentTarget = { tool: 'claude', pane: '%3', hookPid: 78881, pid: 78881 };
  const second: AgentTarget = { tool: 'claude', pane: '%3', hookPid: 90210, pid: 78881 };
  assert.equal(planKillAgent(first).candidates[0], 78881);
  assert.equal(planKillAgent(second).candidates[0], 90210);
});

test('a nested agent is killed by its own pid, never the pane’s', () => {
  // The pane's outermost claude is the agent that *spawned* this one.
  const agent: AgentTarget = { tool: 'claude', pane: '%3', nested: true, hookPid: 90210, pid: 78881 };
  assert.deepEqual(planKillAgent(agent).candidates, [90210]);
});

test('a nested agent with no pid of its own is refused, not guessed', () => {
  const agent: AgentTarget = { tool: 'claude', pane: '%3', nested: true, pid: 78881 };
  const plan = planKillAgent(agent);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.refusal ?? '', /spawned it/);
});

test('a daemon-hosted agent is killed by its worker, never by $CLAUDE_PID', () => {
  // Its hookPid is the pooled bg-spare helper: spawned before the session and
  // still alive after it, so killing it would spare the agent and hit the pool.
  const agent: AgentTarget = { tool: 'claude', pane: '%3', hosted: 'daemon', hookPid: 9261, pid: 85935 };
  assert.deepEqual(planKillAgent(agent).candidates, [85935]);
});

test('a daemon-hosted agent with no rostered worker is refused', () => {
  const agent: AgentTarget = { tool: 'claude', hosted: 'daemon', hookPid: 9261 };
  const plan = planKillAgent(agent);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.refusal ?? '', /no worker process/);
});

test('an agent with no pid at all is refused', () => {
  const plan = planKillAgent({ tool: 'codex' });
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.refusal);
});

test('pid 1 and 0 are never candidates', () => {
  assert.deepEqual(planKillAgent({ tool: 'claude', hookPid: 1, pid: 0 }).candidates, []);
});

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    key: 'claude:abc',
    tool: 'claude',
    status: 'working',
    provenance: 'hook',
    since: 100,
    lastEventAt: 100,
    lastEvent: 'PreToolUse',
    turns: 1,
    toolCalls: 3,
    errorCount: 0,
    subagents: 0,
    ...overrides,
  };
}

test('marking an agent gone is what makes a killed row disappear', () => {
  const states = new Map([['claude:abc', state()]]);
  assert.equal(markGone(states, 'claude:abc', 500), true);
  const after = states.get('claude:abc') as AgentState;
  assert.equal(after.status, 'gone');
  assert.equal(after.since, 500);
  assert.equal(after.lastEventAt, 500);
  // Counters survive: the row is over, not erased.
  assert.equal(after.toolCalls, 3);
});

test('marking an unknown agent gone is a no-op', () => {
  // An agent we only ever found in `ps` has no state to mark, and needs none.
  const states = new Map([['claude:abc', state()]]);
  assert.equal(markGone(states, 'claude:pane:%9', 500), false);
  assert.equal(states.size, 1);
});
