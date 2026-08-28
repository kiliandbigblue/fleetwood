import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, findTaskSession, parsePanes, parseSessions, planSessionKill, tmuxEnv } from '../src/tmux.ts';
import type { ClientInfo, SessionRow } from '../src/tmux.ts';

const SEP = '\x1f';
const row = (...fields: string[]): string => fields.join(SEP);

test('parseSessions reads fleetwood metadata from user options', () => {
  const stdout = [
    row('$0', 'HOME', '0', '1785781023', '/Users/k', '', '', '', '', '', '', ''),
    row(
      '$1',
      'atlas-pr-1234',
      '1',
      '1785781153',
      '/Users/k/projects/atlas/.agents/worktrees/pr-1234',
      'pr',
      'bigbluedisco/atlas',
      'feat/foo',
      'bigbluedisco/atlas#1234',
      '/Users/k/projects/atlas/.agents/worktrees/pr-1234',
      '',
      '',
    ),
    // A multi-repo task session: several repos, one branch, one task folder.
    row(
      '$2',
      'flow-execution-labels',
      '1',
      '1785790000',
      '/Users/k/projects/.agents/tasks/flow-execution-labels',
      'task',
      'bigbluedisco/proto,bigbluedisco/graphy',
      'fix/flow-execution-labels',
      '',
      '',
      'flow-execution-labels',
      '/Users/k/projects/.agents/tasks/flow-execution-labels',
    ),
  ].join('\n');

  const sessions = parseSessions(stdout);
  assert.equal(sessions.length, 3);

  // Unset user options come back as empty strings; they must not become "".
  assert.deepEqual(sessions[0]?.meta, {
    kind: undefined,
    repo: undefined,
    branch: undefined,
    pr: undefined,
    worktree: undefined,
    task: undefined,
    taskdir: undefined,
  });
  assert.equal(sessions[0]?.attached, 0);

  assert.equal(sessions[1]?.name, 'atlas-pr-1234');
  assert.equal(sessions[1]?.attached, 1);
  assert.equal(sessions[1]?.meta.kind, 'pr');
  assert.equal(sessions[1]?.meta.pr, 'bigbluedisco/atlas#1234');
  assert.equal(sessions[1]?.meta.branch, 'feat/foo');

  // Task sessions carry the slug, the shared branch, and every repo involved.
  assert.equal(sessions[2]?.meta.kind, 'task');
  assert.equal(sessions[2]?.meta.task, 'flow-execution-labels');
  assert.equal(sessions[2]?.meta.branch, 'fix/flow-execution-labels');
  assert.equal(sessions[2]?.meta.repo, 'bigbluedisco/proto,bigbluedisco/graphy');
  assert.equal(sessions[2]?.meta.taskdir, '/Users/k/projects/.agents/tasks/flow-execution-labels');
  assert.equal(sessions[2]?.meta.pr, undefined);
});

test('a row missing the newer fields still parses (older tmux state)', () => {
  // Sessions stamped before task support existed have only the first five options.
  const sessions = parseSessions(row('$9', 'legacy', '0', '100', '/tmp', 'project'));
  assert.equal(sessions[0]?.meta.kind, 'project');
  assert.equal(sessions[0]?.meta.task, undefined);
  assert.equal(sessions[0]?.name, 'legacy');
});

test('parsePanes handles the version-string command Claude Code reports', () => {
  // Verbatim shape of real output: pane_current_command is "2.1.220" because the
  // pane process is the versioned binary, which is why detection uses argv.
  const stdout = row(
    '$1',
    'fleetwood',
    '@1',
    '1',
    'zsh',
    '1',
    '%3',
    '0',
    '78799',
    '2.1.220',
    '/Users/k/projects/fleetwood',
    '1',
    '180',
    '50',
    '⠐ Set up tmux tool',
  );

  const panes = parsePanes(stdout);
  assert.equal(panes.length, 1);
  assert.equal(panes[0]?.paneId, '%3');
  assert.equal(panes[0]?.pid, 78799);
  assert.equal(panes[0]?.command, '2.1.220');
  assert.equal(panes[0]?.title, '⠐ Set up tmux tool');
  assert.equal(panes[0]?.active, true);
});

test('a separator inside a pane title cannot shift other columns', () => {
  const stdout = row(
    '$1',
    's',
    '@1',
    '1',
    'w',
    '1',
    '%9',
    '2',
    '42',
    'zsh',
    '/tmp',
    '0',
    '80',
    '24',
    `title with ${SEP} inside`,
  );
  const panes = parsePanes(stdout);
  assert.equal(panes[0]?.paneId, '%9');
  assert.equal(panes[0]?.height, 24);
  assert.equal(panes[0]?.title, `title with ${SEP} inside`);
});

test('buildTree groups panes into windows and sorts by index', () => {
  const sessions = parseSessions(row('$1', 's', '1', '100', '/tmp', '', '', '', '', ''));
  const panes = parsePanes(
    [
      row('$1', 's', '@2', '2', 'second', '0', '%5', '0', '10', 'zsh', '/tmp', '0', '80', '24', ''),
      row('$1', 's', '@1', '1', 'first', '1', '%3', '1', '11', 'zsh', '/tmp', '0', '80', '24', ''),
      row('$1', 's', '@1', '1', 'first', '1', '%2', '0', '12', 'zsh', '/tmp', '1', '80', '24', ''),
    ].join('\n'),
  );

  const tree = buildTree(sessions, panes);
  assert.equal(tree.length, 1);
  assert.deepEqual(
    tree[0]?.windows.map((w) => w.index),
    [1, 2],
  );
  // Panes sorted by pane_index, not by discovery order.
  assert.deepEqual(
    tree[0]?.windows[0]?.panes.map((p) => p.paneId),
    ['%2', '%3'],
  );
  // Window-level fields must not leak into pane objects.
  assert.equal('windowName' in (tree[0]?.windows[0]?.panes[0] ?? {}), false);
});

test('a session with no panes still appears', () => {
  const sessions = parseSessions(row('$7', 'empty', '0', '100', '/tmp', '', '', '', '', ''));
  const tree = buildTree(sessions, []);
  assert.equal(tree[0]?.name, 'empty');
  assert.deepEqual(tree[0]?.windows, []);
});

test('parseSessions drops rows that lost their separators', () => {
  // What tmux prints for a client it does not think speaks UTF-8: every
  // non-printable byte, the separator included, rewritten as "_".
  const sanitized = [
    '$0_HOME_0_1785781023_/Users/k_______',
    '$1_atlas-pr-1234_1_1785781153_/Users/k/projects/atlas_pr_______',
  ].join('\n');

  // Better an empty fleet than two sessions with no name, no path and no panes.
  assert.deepEqual(parseSessions(sanitized), []);
});

test('parsePanes drops rows that lost their separators', () => {
  const sanitized = '$0_HOME_@0_0_zsh_1_%0_0_4242_zsh_/Users/k_1_120_40_zsh';
  assert.deepEqual(parsePanes(sanitized), []);
});

test('tmuxEnv forces a UTF-8 locale over whatever the app was launched with', () => {
  const { LC_ALL, LC_CTYPE, LANG, PATH } = process.env;
  try {
    // A GUI launch has none of the three; LC_ALL=C is the other way to get
    // sanitized output, and it wins over LC_CTYPE, so that is what we set.
    delete process.env.LC_CTYPE;
    delete process.env.LANG;
    process.env.LC_ALL = 'C';
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';

    const env = tmuxEnv();
    assert.match(env.LC_ALL ?? '', /UTF-8/i);
    // Read at call time, not at import: the app repairs PATH after this module
    // loads, and tmux has to be findable.
    assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin');
  } finally {
    if (LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = LC_ALL;
    if (LC_CTYPE !== undefined) process.env.LC_CTYPE = LC_CTYPE;
    if (LANG !== undefined) process.env.LANG = LANG;
    if (PATH !== undefined) process.env.PATH = PATH;
  }
});

/**
 * Archiving a task kills its session. These cover where the clients go first —
 * getting it wrong detaches Ghostty back to a bare shell, which is the bug.
 */
const session = (name: string, createdAt: number, attached = 0): SessionRow => ({
  sessionId: `$${name}`,
  name,
  attached,
  createdAt,
  path: `/Users/k/${name}`,
  meta: {
    kind: undefined,
    repo: undefined,
    branch: undefined,
    pr: undefined,
    worktree: undefined,
    task: undefined,
    taskdir: undefined,
  },
});

const client = (tty: string, name: string): ClientInfo => ({
  tty,
  session: name,
  termName: 'xterm-ghostty',
});

test('the client on a doomed session is moved to the oldest surviving one', () => {
  const sessions = [
    session('atlas-pr-1', 1785781153),
    session('HOME', 1785781023),
    session('doomed', 1785790000, 1),
  ];
  const plan = planSessionKill(sessions, [client('/dev/ttys004', 'doomed')], 'doomed');
  assert.equal(plan.switchTo, 'HOME');
  assert.deepEqual(plan.ttys, ['/dev/ttys004']);
});

test('clients attached elsewhere are left where they are', () => {
  const sessions = [session('HOME', 1785781023, 1), session('doomed', 1785790000, 1)];
  const clients = [client('/dev/ttys004', 'HOME'), client('/dev/ttys005', 'doomed')];
  assert.deepEqual(planSessionKill(sessions, clients, 'doomed').ttys, ['/dev/ttys005']);
});

test('nothing attached to it means nothing to move', () => {
  const sessions = [session('HOME', 1785781023, 1), session('doomed', 1785790000)];
  const plan = planSessionKill(sessions, [client('/dev/ttys004', 'HOME')], 'doomed');
  assert.equal(plan.switchTo, undefined);
  assert.deepEqual(plan.ttys, []);
});

test('the last session has nowhere to go, so the client detaches as before', () => {
  const plan = planSessionKill(
    [session('doomed', 1785790000, 1)],
    [client('/dev/ttys004', 'doomed')],
    'doomed',
  );
  assert.equal(plan.switchTo, undefined);
  assert.deepEqual(plan.ttys, ['/dev/ttys004']);
});

test('sessions created in the same second fall back to name order', () => {
  const sessions = [
    session('proto', 1785781023),
    session('atlas', 1785781023),
    session('doomed', 1785790000, 1),
  ];
  const plan = planSessionKill(sessions, [client('/dev/ttys004', 'doomed')], 'doomed');
  assert.equal(plan.switchTo, 'atlas');
});

/**
 * findTaskSession backs the self-heal that follows a tmux-resurrect restore:
 * the session comes back with its name and cwd, but resurrect has no idea
 * about our `@fw_task` option, so it never comes back stamped.
 */
test('a session already stamped for the task is matched by the option, not its name', () => {
  const stamped = { ...session('some-other-name', 1785781023), meta: { ...session('x', 0).meta, task: 'flow-execution-labels' } };
  const found = findTaskSession([session('unrelated', 1785781000), stamped], 'flow-execution-labels', '/Users/k/flow-execution-labels');
  assert.equal(found?.session.name, 'some-other-name');
  assert.equal(found?.adopted, false);
});

test('an unstamped session named for the task is adopted', () => {
  const sessions = [session('unrelated', 1785781000), session('flow-execution-labels', 1785790000)];
  const found = findTaskSession(sessions, 'flow-execution-labels', '/Users/k/flow-execution-labels');
  assert.equal(found?.session.name, 'flow-execution-labels');
  assert.equal(found?.adopted, true);
});

test('an unstamped session sitting at the task folder is adopted by path, whatever its name', () => {
  const renamed = { ...session('0-flow-execution-labels', 1785790000), path: '/Users/k/tasks/flow-execution-labels' };
  const found = findTaskSession([session('unrelated', 1785781000), renamed], 'flow-execution-labels', '/Users/k/tasks/flow-execution-labels');
  assert.equal(found?.session.name, '0-flow-execution-labels');
  assert.equal(found?.adopted, true);
});

test('no session matches by option, name or path', () => {
  const sessions = [session('unrelated', 1785781000)];
  assert.equal(findTaskSession(sessions, 'flow-execution-labels', '/Users/k/flow-execution-labels'), undefined);
});

test('a stamped session for a different task is not adopted for this one', () => {
  const other = { ...session('atlas-pr-1', 1785781023), meta: { ...session('x', 0).meta, task: 'atlas-pr-1' } };
  assert.equal(findTaskSession([other], 'flow-execution-labels', '/Users/k/flow-execution-labels'), undefined);
});
