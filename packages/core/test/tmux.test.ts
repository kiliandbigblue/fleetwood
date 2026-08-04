import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, parsePanes, parseSessions } from '../src/tmux.ts';

const SEP = '\x1f';
const row = (...fields: string[]): string => fields.join(SEP);

test('parseSessions reads fleetwood metadata from user options', () => {
  const stdout = [
    row('$0', 'HOME', '0', '1785781023', '/Users/k', '', '', '', '', ''),
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
    ),
  ].join('\n');

  const sessions = parseSessions(stdout);
  assert.equal(sessions.length, 2);

  // Unset user options come back as empty strings; they must not become "".
  assert.deepEqual(sessions[0]?.meta, {
    kind: undefined,
    repo: undefined,
    branch: undefined,
    pr: undefined,
    worktree: undefined,
  });
  assert.equal(sessions[0]?.attached, 0);

  assert.equal(sessions[1]?.name, 'atlas-pr-1234');
  assert.equal(sessions[1]?.attached, 1);
  assert.equal(sessions[1]?.meta.kind, 'pr');
  assert.equal(sessions[1]?.meta.pr, 'bigbluedisco/atlas#1234');
  assert.equal(sessions[1]?.meta.branch, 'feat/foo');
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
