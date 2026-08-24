import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorSubagentKeys, matchDaemonPanes, reconcileWithScreen } from '../src/fleet.ts';
import type { DaemonWorker } from '../src/claudeDaemon.ts';
import { readScreen } from '../src/screen.ts';
import type { AgentState } from '../src/events.ts';

const WORKER: DaemonWorker = {
  sessionId: '21ad03a2-af31-4e13-82e7-1c58aca3156c',
  pid: 85935,
  cwd: '/Users/k/projects/fleetwood',
  cliVersion: '2.1.220',
};

/** tmux reports a Claude Code pane's command as the versioned binary's name. */
const PANE = { paneId: '%3', cwd: '/Users/k/projects/fleetwood', command: '2.1.220' };

test('a daemon-hosted agent is matched to the pane displaying it', () => {
  const bound = matchDaemonPanes([WORKER], [PANE]);
  assert.equal(bound.get(WORKER.sessionId), '%3');
});

test('a pane cd’d below the launch directory still matches', () => {
  const bound = matchDaemonPanes([WORKER], [{ ...PANE, cwd: '/Users/k/projects/fleetwood/packages/core' }]);
  assert.equal(bound.get(WORKER.sessionId), '%3');
});

test('a pane in an unrelated repo is not a match', () => {
  const bound = matchDaemonPanes([WORKER], [{ ...PANE, cwd: '/Users/k/projects/atlas' }]);
  assert.equal(bound.size, 0);
  // A sibling directory shares a prefix but not a path — the `/` boundary matters.
  assert.equal(matchDaemonPanes([WORKER], [{ ...PANE, cwd: '/Users/k/projects/fleetwood-old' }]).size, 0);
});

test('a version tmux disagrees with rules a pane out', () => {
  assert.equal(matchDaemonPanes([WORKER], [{ ...PANE, command: '2.1.221' }]).size, 0);
  // Not every pane reports a version; then there is simply no evidence either way.
  assert.equal(matchDaemonPanes([WORKER], [{ ...PANE, command: 'node' }]).get(WORKER.sessionId), '%3');
});

test('ambiguity is left unresolved rather than guessed', () => {
  // Two candidate panes for one worker: attaching it to either would risk
  // printing this agent's status against the other's terminal, and the
  // approve/deny buttons act on that pane.
  const twoPanes = matchDaemonPanes([WORKER], [PANE, { ...PANE, paneId: '%9' }]);
  assert.equal(twoPanes.size, 0);

  // And two workers for one pane.
  const twoWorkers = matchDaemonPanes(
    [WORKER, { ...WORKER, sessionId: 'other-session', pid: 90000 }],
    [PANE],
  );
  assert.equal(twoWorkers.size, 0);
});

test('one unambiguous pair survives alongside an ambiguous one', () => {
  const other: DaemonWorker = { ...WORKER, sessionId: 'atlas-session', pid: 90000, cwd: '/Users/k/projects/atlas' };
  const bound = matchDaemonPanes(
    [WORKER, other],
    [PANE, { paneId: '%9', cwd: '/Users/k/projects/atlas', command: '2.1.220' }],
  );
  assert.equal(bound.get(WORKER.sessionId), '%3');
  assert.equal(bound.get('atlas-session'), '%9');
});

/**
 * Verbatim capture of a pane whose agent has just asked for input: the prompt box
 * is empty and there is nothing on screen to read. Claude Code's "waiting for
 * your input" notification looks exactly like an idle terminal.
 */
const WAITING_FOR_INPUT = `
────────────────────────────────────────────────
❯ now find any typos in the README
────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← 1 agent
`;

const MID_TURN = `
⏺ Running 1 shell command…

✻ Whirring… (6m 1s · ↓ 19.4k tokens · thinking)
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt
`;

test('an unreadable screen never promotes an agent waiting on the human to working', () => {
  const state = { status: 'blocked_input' as const, provenance: 'hook' as const };
  const verdict = reconcileWithScreen(state, readScreen(WAITING_FOR_INPUT), true);
  assert.equal(verdict.status, 'blocked_input', 'this is the row that means "you are the bottleneck"');
  assert.equal(verdict.provenance, 'stale', 'unconfirmed, but still the best thing we know');
});

test('a screen that positively says working overrides a stale blocked state', () => {
  const state = { status: 'blocked_permission' as const, provenance: 'hook' as const };
  const verdict = reconcileWithScreen(state, readScreen(MID_TURN), true);
  assert.equal(verdict.status, 'working');
  assert.equal(verdict.provenance, 'screen');
});

test('a fresh hook state is not second-guessed by the screen', () => {
  const state = { status: 'blocked_input' as const, provenance: 'hook' as const };
  const verdict = reconcileWithScreen(state, readScreen(MID_TURN), false);
  assert.equal(verdict.status, 'blocked_input');
  assert.equal(verdict.provenance, 'hook');
});

test('a permission prompt on screen wins whether or not the hook is stale', () => {
  const prompt = `
╭────────────────────────────────────────────╮
│ Bash command                               │
│   rm -rf build                              │
│ Do you want to proceed?                     │
│ ❯ 1. Yes                                    │
│   2. No, and tell Claude what to do (esc)   │
╰────────────────────────────────────────────╯
`;
  const fresh = reconcileWithScreen({ status: 'working', provenance: 'hook' }, readScreen(prompt), false);
  assert.equal(fresh.status, 'blocked_permission');
  assert.equal(fresh.provenance, 'screen', 'the hook said working, so this is the screen talking');
  assert.equal(fresh.prompt?.approve, '1');
  assert.equal(fresh.prompt?.deny, '2');

  // Already reported blocked: the screen corroborates the hook rather than
  // downgrading how much the status is trusted.
  const corroborated = reconcileWithScreen(
    { status: 'blocked_permission', provenance: 'hook' },
    readScreen(prompt),
    true,
  );
  assert.equal(corroborated.provenance, 'hook');
});

/**
 * The shape a real Cursor pane produces: one conversation the human prompts,
 * and one id per delegated subagent, all carrying the parent's $TMUX_PANE.
 */
function cursorState(over: Partial<AgentState> & { key: string }): AgentState {
  return {
    tool: 'cursor',
    pane: '%5',
    status: 'working',
    provenance: 'hook',
    since: 1_000,
    lastEventAt: 1_000,
    lastEvent: 'PreToolUse',
    turns: 0,
    toolCalls: 0,
    errorCount: 0,
    subagents: 0,
    ...over,
  };
}

test('cursor subagents on the parent’s pane are hidden, not the parent', () => {
  const parent = cursorState({ key: 'cursor:parent', turns: 6, lastEvent: 'UserPromptSubmit', lastEventAt: 2_000 });
  // Subagents stay noisier than the parent that delegated to them: the freshest
  // event on the pane belongs to a row we want gone.
  const busy = cursorState({ key: 'cursor:busy', lastEventAt: 2_500 });
  const finished = cursorState({ key: 'cursor:finished', lastEventAt: 1_100 });

  const hidden = cursorSubagentKeys([parent, busy, finished]);
  assert.deepEqual([...hidden].sort(), ['cursor:busy', 'cursor:finished']);
});

test('a lone cursor conversation is never mistaken for a subagent', () => {
  // A session that has started but not been prompted yet has no turns either.
  const fresh = cursorState({ key: 'cursor:fresh', lastEvent: 'SessionStart' });
  assert.equal(cursorSubagentKeys([fresh]).size, 0);
});

test('a reused pane keeps the newer conversation, not the abandoned one', () => {
  // Cursor reports no session end, so yesterday's parent is still in the store.
  const stale = cursorState({ key: 'cursor:old', turns: 3, lastEventAt: 1_000 });
  const current = cursorState({ key: 'cursor:new', turns: 1, lastEventAt: 9_000 });
  assert.deepEqual([...cursorSubagentKeys([stale, current])], ['cursor:old']);
});

test('other tools sharing the pane are left alone', () => {
  const parent = cursorState({ key: 'cursor:parent', turns: 2, lastEventAt: 2_000 });
  const sub = cursorState({ key: 'cursor:sub', lastEventAt: 3_000 });
  const claude = cursorState({ key: 'claude:c', tool: 'claude', turns: 4, lastEventAt: 5_000 });
  assert.deepEqual([...cursorSubagentKeys([parent, sub, claude])], ['cursor:sub']);
});
