import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import type { SwitchTarget } from '@fleetwood/core';
import { renderRows } from '../src/switch.ts';

/*
 * The rows, as text. Colour is off here — `ui.ts` paints only into a TTY — so
 * what these assert on is the layout: which columns a row spends its width on,
 * and which it leaves out because something else already said it.
 */

const TASK = {
  slug: 'orders-b2b-flag-migration',
  branch: 'feature/orders-b2b-flag-migration',
  dir: '/t/orders-b2b-flag-migration',
  type: 'feature',
  microservice: 'orders',
  summary: 'b2b flag migration',
  createdAt: 0,
  repos: [
    { name: 'reflow-orders-b2b-flag-migration', path: '/w/1', repo: 'bigbluedisco/reflow', dirty: 0 },
    { name: 'proto-orders-b2b-flag-migration', path: '/w/2', repo: 'bigbluedisco/proto', dirty: 0 },
  ],
};

function target(over: Partial<SwitchTarget> = {}): SwitchTarget {
  return { kind: 'session', tier: 'live', ref: 'fleetwood', label: 'fleetwood', ...over };
}

/** The text of one row, without the index field fzf is told not to display. */
function shown(t: SwitchTarget): string {
  return (renderRows([t])[0] as string).split('\t')[1] as string;
}

test('the index leads, and is the only thing before the first tab', () => {
  const rows = renderRows([target(), target({ ref: 'atlas', label: 'atlas' })]);
  assert.deepEqual(
    rows.map((row) => row.split('\t')[0]),
    ['0', '1'],
  );
  // Exactly two fields: a third would be a hidden column, which fzf cannot
  // search — see the comment on renderRows.
  assert.equal(rows[0]?.split('\t').length, 2);
});

test('every tier starts its name in the same column', () => {
  const rows = [
    shown(target({ ref: 'x', label: 'x', panes: 1 })),
    shown(target({ kind: 'task', tier: 'dormant', ref: 'x', label: 'x', task: TASK })),
    shown(target({ kind: 'project', tier: 'project', ref: '/p/x', label: 'x', path: '/p/x' })),
  ];
  // The glyph, then the two-column gutter the `✋` shares: a name starts at 4
  // whether the row is a live session, a dormant task or a bare directory.
  for (const row of rows) {
    assert.match(row.slice(0, 4), /^\S\s{3}$/);
    assert.equal(row.indexOf('x'), 4);
  }
});

test('an attention flag takes the gutter, not the name column', () => {
  const plain = shown(target({ panes: 2 }));
  const blocked = shown(target({ panes: 2, needsAttention: true }));
  assert.equal(plain.indexOf('fleetwood'), blocked.indexOf('fleetwood'));
  assert.ok(blocked.includes('✋'));
});

test('a task’s branch is not printed beside the slug it repeats — the repos are', () => {
  const row = shown(
    target({ kind: 'task', tier: 'dormant', ref: TASK.slug, label: TASK.slug, branch: TASK.branch, task: TASK }),
  );
  assert.ok(!row.includes('feature/'));
  assert.ok(row.includes('2 wt'));
  // Bare names, deduped, in the column the branch would have restated.
  assert.ok(row.includes('reflow proto'));
});

test('a branch the name does not already give you is printed', () => {
  const row = shown(target({ label: 'atlas-pr-3671', branch: 'fix/address-validation', panes: 1 }));
  assert.ok(row.includes('fix/address-validation'));
});

test('a worktree with no remote is named by its directory, less the task slug', () => {
  const task = {
    ...TASK,
    slug: 'read-later-ui-improve',
    branch: 'feature/read-later-ui-improve',
    repos: [{ name: 'read-later-ui-read-later-ui-improve', path: '/w/1', dirty: 0 }],
  };
  const row = shown(target({ kind: 'task', tier: 'dormant', ref: task.slug, label: task.slug, task }));
  assert.ok(row.includes('read-later-ui'));
  assert.ok(!row.includes('read-later-ui-read-later-ui'));
});

test('a stack layer keeps the branch that distinguishes it from its siblings', () => {
  // `worktreeShortName` takes off the task's slug and nothing else, so five
  // worktrees of one repo do not all read `reflow`.
  const task = {
    ...TASK,
    repos: [
      { name: 'reflow-orders-use-order-type', path: '/w/1', dirty: 0 },
      { name: 'reflow-orders-dual-write', path: '/w/2', dirty: 0 },
    ],
  };
  const row = shown(target({ kind: 'task', tier: 'dormant', ref: task.slug, label: task.slug, task }));
  assert.ok(row.includes('reflow-orders-use'));
});

test('a name too wide for its column is clipped, not allowed to shift the row', () => {
  const long = 'receive-receive-item-into-rebin-or-mono-item';
  const wide = shown(target({ label: long, panes: 1 }));
  const short = shown(target({ label: 'atlas', panes: 1 }));
  assert.ok(wide.includes('…'));
  assert.equal(wide.indexOf('1 pane'), short.indexOf('1 pane'));
});

test('an agent row is indented under its session and named by its window', () => {
  const agent = {
    key: 'claude:%7',
    tool: 'claude' as const,
    pane: '%7',
    status: 'blocked_permission' as const,
    provenance: 'hook' as const,
    since: 0,
    lastEventAt: 0,
    lastEvent: 'PermissionRequest',
    turns: 1,
    toolCalls: 1,
    errorCount: 0,
    subagents: 0,
    alive: true,
    nested: false,
    forSeconds: 240,
    // The real home, since that is the only one `shorten` rewrites — a path
    // under somebody else's is not this machine's to abbreviate.
    activity: `Write: ${homedir()}/projects/fleetwood/packages/cli/src/switch.ts`,
  };
  const row = shown(target({ kind: 'agent', ref: '%7', agent, window: { index: 3, name: 'claude' } }));
  assert.match(row, /^\s+↳ 3:claude/);
  assert.ok(row.includes('permission'));
  assert.ok(row.includes('4m'));
  // $HOME written as ~ wherever it falls, since an activity line is a command
  // and the home directory turns up in the middle of one.
  assert.ok(!row.includes(homedir()));
  assert.ok(row.includes('~/projects'));
});

test('a session with no agent says how many panes it has instead', () => {
  assert.ok(shown(target({ panes: 3 })).includes('3 panes'));
  // Singular, and last on the row — the column's padding is trimmed off the end
  // so fzf's highlight does not run past the text.
  assert.match(shown(target({ panes: 1 })), /1 pane$/);
});

test('several agents show the lead’s status and the count', () => {
  const lead = {
    key: 'claude:%1',
    tool: 'claude' as const,
    pane: '%1',
    status: 'working' as const,
    provenance: 'hook' as const,
    since: 0,
    lastEventAt: 0,
    lastEvent: 'PreToolUse',
    turns: 1,
    toolCalls: 1,
    errorCount: 0,
    subagents: 0,
    alive: true,
    nested: false,
    forSeconds: 10,
  };
  assert.ok(shown(target({ lead, agentCount: 2 })).includes('working'));
  assert.ok(shown(target({ lead, agentCount: 2 })).includes('×2'));
  // One agent is the session's own state, not a tally.
  assert.ok(!shown(target({ lead, agentCount: 1 })).includes('×'));
});
