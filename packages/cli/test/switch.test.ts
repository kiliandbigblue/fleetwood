import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import type { SwitchTarget } from '@fleetwood/core';
import { layoutFor, renderRows } from '../src/switch.ts';
import { width } from '../src/ui.ts';

/**
 * Where a substring starts, in terminal cells rather than string indices.
 *
 * The distinction is the whole point of these assertions: `✋` is one JavaScript
 * character and two columns of terminal, so a row measured by `indexOf` can be
 * "aligned" in the string and visibly a column out — which is exactly the bug
 * the gutter had.
 */
function cellOf(row: string, find: string): number {
  const at = row.indexOf(find);
  return at === -1 ? -1 : width(row.slice(0, at));
}

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

const AGENT = {
  key: 'claude:%7',
  tool: 'claude' as const,
  pane: '%7',
  provenance: 'hook' as const,
  since: 0,
  lastEventAt: 0,
  turns: 1,
  toolCalls: 1,
  errorCount: 0,
  subagents: 0,
  alive: true,
  nested: false,
};

const BLOCKED = {
  ...AGENT,
  status: 'blocked_permission' as const,
  lastEvent: 'PermissionRequest',
  forSeconds: 240,
};

const WORKING = {
  ...AGENT,
  status: 'working' as const,
  lastEvent: 'PreToolUse',
  forSeconds: 120,
  activity: 'Bash: pnpm test',
};

function target(over: Partial<SwitchTarget> = {}): SwitchTarget {
  return { kind: 'session', tier: 'live', ref: 'fleetwood', label: 'fleetwood', ...over };
}

/**
 * The text of one row, without the index field fzf is told not to display.
 *
 * At the narrow layout, always: the two elastic columns are a function of the
 * terminal's width, and a test that read the real one would pass or fail by the
 * size of the window it was run in.
 */
function shown(t: SwitchTarget, columns = 90): string {
  return (renderRows([t], columns)[0] as string).split('\t')[1] as string;
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
    assert.equal(cellOf(row, 'x'), 4);
  }
});

test('an attention flag takes the gutter, not the name column', () => {
  const plain = shown(target({ panes: 2 }));
  const blocked = shown(target({ panes: 2, needsAttention: true }));
  // In cells, not characters. `✋` is one character and two columns, so the old
  // `✋ ` — flag plus a space, to match two spaces — was three columns wide and
  // pushed every blocked session's name one to the right of all the others.
  assert.equal(cellOf(blocked, 'fleetwood'), cellOf(plain, 'fleetwood'));
  assert.ok(blocked.includes('✋'));
});

test('every kind of row puts its last column in the same place', () => {
  // The columns exist before the rows do: an agent row used to skip the count
  // column and carry a six-wide age where a session had an eleven-wide meta,
  // which left its activity seven cells adrift of the repos above it.
  const session = shown(target({ panes: 2, task: TASK }));
  const agent = shown(
    target({ kind: 'agent', ref: '%7', agent: WORKING, window: { index: 3, name: 'claude' } }),
  );
  assert.equal(cellOf(agent, 'Bash'), cellOf(session, 'reflow'));
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

test('past the narrow layout the name grows first, then the tail', () => {
  const narrow = layoutFor(90);
  assert.deepEqual(narrow, { name: 30, tail: 26 });
  // Ten cells spare, and the name takes all of them: it is what you are typing.
  assert.deepEqual(layoutFor(100), { name: 40, tail: 26 });
  // Past the longest slug there is, the name stops and the tail takes the rest.
  assert.deepEqual(layoutFor(120), { name: 44, tail: 42 });
  // A terminal narrower than the fixed columns still gets the narrow layout
  // rather than a negative one; fzf clips what does not fit.
  assert.deepEqual(layoutFor(40), narrow);
});

test('a wider terminal spends the extra width on the name, not on padding', () => {
  const long = 'receive-receive-item-into-rebin-or-mono-item';
  assert.ok(shown(target({ label: long, panes: 1 })).includes('…'));
  // The same row in a popup with room for it: whole, because the pane that used
  // to carry the rest of the name is gone.
  assert.ok(!shown(target({ label: long, panes: 1 }), 140).includes('…'));
});

test('an agent row is indented under its session and named by its window', () => {
  const agent = {
    ...BLOCKED,
    forSeconds: 240,
    activity: 'Claude needs your permission to use Bash',
  };
  const row = shown(target({ kind: 'agent', ref: '%7', agent, window: { index: 3, name: 'claude' } }));
  // The `↳` is the row's own mark, in the column a session's `○` occupies, so
  // the two names start together.
  assert.match(row, /^↳\s{3}3:claude/);
  assert.ok(row.includes('permission'));
  assert.ok(row.includes('4m'));
  // The notification text is the chip spelled out — `✋ permission` two columns
  // to its left — so it does not also get the widest column in the list.
  assert.ok(!row.includes('needs your permission'));
});

test('a blocked agent ends on the question, which is the reason to go there', () => {
  const agent = {
    ...BLOCKED,
    activity: 'Claude needs your permission to use Bash',
    prompt: { question: 'Run rm -rf build?', options: [] },
  };
  const row = shown(target({ kind: 'agent', ref: '%7', agent }));
  assert.ok(row.includes('Run rm -rf build?'));
  assert.ok(!row.includes('needs your permission'));
});

test('a working agent keeps both ends of its command, and loses the middle', () => {
  const agent = {
    ...WORKING,
    // The real home, since that is the only one `shorten` rewrites — a path
    // under somebody else's is not this machine's to abbreviate.
    activity: `Bash: cd ${homedir()}/projects/.agents/tasks/print-v2 && pnpm test`,
  };
  const row = shown(target({ kind: 'agent', ref: '%7', agent }));
  // The tool says what kind of thing is happening and the end says which one.
  assert.ok(row.includes('Bash: '));
  assert.ok(row.includes('pnpm test'));
  // $HOME written as ~ wherever it falls, since an activity line is a command
  // and the home directory turns up in the middle of one.
  assert.ok(!row.includes(homedir()));
});

test('an agent row is named by what the agent called the conversation', () => {
  const agent = {
    key: 'claude:%7',
    tool: 'claude' as const,
    pane: '%7',
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
    forSeconds: 120,
  };
  const window = { index: 3, name: 'claude' };
  const named = shown(target({ kind: 'agent', ref: '%7', agent, window, title: 'Mono Or Multi' }));
  assert.ok(named.includes('Mono Or Multi'));
  // The window is in the preview, not spent twice on the row.
  assert.ok(!named.includes('3:claude'));
  // Without a title, the pane's window is the useful thing left to say.
  assert.ok(shown(target({ kind: 'agent', ref: '%7', agent, window })).includes('3:claude'));
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
