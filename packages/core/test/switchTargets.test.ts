import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwitchTargets } from '../src/switchTargets.ts';
import type { FleetAgent, FleetSession } from '../src/fleet.ts';
import type { LocalRepo } from '../src/repoIndex.ts';
import type { Task } from '../src/task.ts';
import type { AgentStatus, PaneInfo } from '../src/types.ts';

function pane(paneId: string, active = false): PaneInfo {
  return {
    paneId,
    paneIndex: 1,
    windowId: '@1',
    sessionId: '$1',
    sessionName: 'fleetwood',
    pid: 100,
    command: 'node',
    cwd: '/Users/k/projects/fleetwood',
    title: '',
    active,
    width: 200,
    height: 50,
  };
}

function agent(paneId: string, status: AgentStatus = 'working'): FleetAgent {
  return {
    key: `claude:${paneId}`,
    tool: 'claude',
    pane: paneId,
    status,
    provenance: 'hook',
    since: 0,
    lastEventAt: 0,
    lastEvent: 'PreToolUse',
    turns: 1,
    toolCalls: 1,
    errorCount: 0,
    subagents: 0,
    alive: true,
    nested: false,
    forSeconds: 60,
  };
}

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: '$1',
    name: 'fleetwood',
    attached: 1,
    createdAt: 1000,
    path: '/Users/k/projects/fleetwood',
    meta: {},
    windows: [{ windowId: '@1', index: 1, name: 'main', active: true, panes: [pane('%1', true)] }],
    agents: [],
    needsAttention: false,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    slug: 'flow-execution-labels',
    branch: 'feature/flow-execution-labels',
    dir: '/Users/k/projects/.agents/tasks/flow-execution-labels',
    type: 'feature',
    microservice: 'flow',
    summary: 'execution labels',
    createdAt: 900,
    repos: [{ name: 'proto-flow-execution-labels', path: '/w/proto', repo: 'bigbluedisco/proto', dirty: 0 }],
    ...over,
  };
}

const NO_INPUT = { sessions: [], tasks: [], projects: [] };

test('every live session is offered, then dormant tasks, then plain directories', () => {
  const targets = buildSwitchTargets({
    sessions: [session()],
    tasks: [task()],
    projects: [{ path: '/Users/k/projects/atlas', isRepo: true, nameWithOwner: 'bigbluedisco/atlas' }],
  });
  assert.deepEqual(
    targets.map((t) => [t.kind, t.ref]),
    [
      ['session', 'fleetwood'],
      ['task', 'flow-execution-labels'],
      ['project', '/Users/k/projects/atlas'],
    ],
  );
});

test('a task with a session is the session row, not a dormant one', () => {
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ name: 'flow-execution-labels', meta: { kind: 'task', task: 'flow-execution-labels' } })],
    tasks: [task({ session: 'flow-execution-labels' })],
  });
  assert.deepEqual(targets.map((t) => t.kind), ['session']);
  // The row carries the task, so it can show the worktree count and the repos.
  assert.equal(targets[0]?.task?.slug, 'flow-execution-labels');
});

test('a restored session that lost its @fw_task is still joined to its task', () => {
  // tmux-resurrect rebuilds the session but not fleetwood's user options, so the
  // join has to come from the side `listTasks` already resolved.
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ name: 'flow-execution-labels', meta: {} })],
    tasks: [task({ session: 'flow-execution-labels' })],
  });
  assert.equal(targets[0]?.task?.slug, 'flow-execution-labels');
});

test('one agent in the session’s active pane needs no row of its own', () => {
  // Switching to the session lands on it: a child row would be the same jump
  // written twice.
  const targets = buildSwitchTargets({ ...NO_INPUT, sessions: [session({ agents: [agent('%1')] })] });
  assert.deepEqual(targets.map((t) => t.kind), ['session']);
  assert.equal(targets[0]?.lead?.pane, '%1');
  assert.equal(targets[0]?.agentCount, 1);
});

test('an agent in a window the session is not showing gets its own row', () => {
  const windows = [
    { windowId: '@1', index: 1, name: 'main', active: true, panes: [pane('%1', true)] },
    { windowId: '@2', index: 2, name: 'claude', active: false, panes: [pane('%7')] },
  ];
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ windows, agents: [agent('%7')] })],
  });
  assert.deepEqual(
    targets.map((t) => [t.kind, t.ref]),
    [
      ['session', 'fleetwood'],
      ['agent', '%7'],
    ],
  );
  // Named by its window, because that is what picking it selects.
  assert.deepEqual(targets[1]?.window, { index: 2, name: 'claude' });
});

test('several agents are all offered, whoever needs you first', () => {
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [
      session({
        windows: [
          { windowId: '@1', index: 1, name: 'main', active: true, panes: [pane('%1', true), pane('%2')] },
        ],
        agents: [agent('%1', 'idle'), agent('%2', 'blocked_permission')],
      }),
    ],
  });
  assert.deepEqual(
    targets.map((t) => t.ref),
    ['fleetwood', '%2', '%1'],
  );
  // The session row speaks for the most urgent of them, and says how many.
  assert.equal(targets[0]?.lead?.status, 'blocked_permission');
  assert.equal(targets[0]?.agentCount, 2);
});

test('a dead agent is no row: it is a jump to nothing', () => {
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ agents: [agent('%1', 'gone'), agent('%2', 'gone')] })],
  });
  assert.deepEqual(targets.map((t) => t.kind), ['session']);
  assert.equal(targets[0]?.lead, undefined);
});

test('a project with a live session is not offered twice', () => {
  const projects: LocalRepo[] = [
    { path: '/Users/k/projects/fleetwood', isRepo: true },
    { path: '/Users/k/projects/atlas', isRepo: true },
  ];
  // Matched by label, so an ordered session is still that project's — and the
  // `.`-to-`_` rule the sessionizer uses is honoured, or `dot.files` would be
  // offered beside the session it already has.
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ name: '+20-fleetwood' }), session({ sessionId: '$2', name: 'dot_files' })],
    projects: [...projects, { path: '/Users/k/dotfiles/dot.files', isRepo: false }],
  });
  assert.deepEqual(
    targets.filter((t) => t.kind === 'project').map((t) => t.ref),
    ['/Users/k/projects/atlas'],
  );
  // And the session's own row is labelled without its slot prefix.
  assert.equal(targets[0]?.label, 'fleetwood');
});

test('hidden sessions stay out unless asked for, as everywhere else', () => {
  const sessions = [session({ name: '-HOME' })];
  assert.equal(buildSwitchTargets({ ...NO_INPUT, sessions }).length, 0);
  const all = buildSwitchTargets({ ...NO_INPUT, sessions, all: true });
  assert.deepEqual(all.map((t) => [t.ref, t.hidden]), [['-HOME', true]]);
});

test('a live task session carries its repos, which is what the row is found by', () => {
  // fzf can only match what a row displays, so the repos have to reach the
  // renderer rather than a hidden field — see `renderRows`.
  const targets = buildSwitchTargets({
    ...NO_INPUT,
    sessions: [session({ name: 'flow-execution-labels', meta: { kind: 'task', task: 'flow-execution-labels' } })],
    tasks: [task({ session: 'flow-execution-labels' })],
  });
  assert.deepEqual(
    targets[0]?.task?.repos.map((r) => r.repo),
    ['bigbluedisco/proto'],
  );
});
