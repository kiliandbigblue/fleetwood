import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalKeys, readScreen } from '../src/screen.ts';

/**
 * Claude Code renders permission prompts in a box. This is the shape a
 * capture-pane returns: box drawing on both edges, the selected option marked
 * with ❯, and the trailing hint text on the last option.
 */
const PERMISSION_PROMPT = `
● I'll remove the stale build output.

╭──────────────────────────────────────────────────────────╮
│ Bash command                                             │
│                                                          │
│   rm -rf build                                           │
│   Remove the build directory                             │
│                                                          │
│ Do you want to proceed?                                  │
│ ❯ 1. Yes                                                 │
│   2. Yes, and don't ask again for rm commands             │
│   3. No, and tell Claude what to do differently (esc)     │
│                                                          │
╰──────────────────────────────────────────────────────────╯
`;

const EDIT_PROMPT = `
╭──────────────────────────────────────────────────────────╮
│ Edit file                                                │
│  packages/core/src/tmux.ts                               │
│                                                          │
│ Do you want to make this edit to tmux.ts?                │
│ ❯ 1. Yes                                                 │
│   2. Yes, allow all edits during this session (shift+tab) │
│   3. No, and tell Claude what to do differently (esc)     │
╰──────────────────────────────────────────────────────────╯
`;

const WORKING_SCREEN = `
● Reading the tmux config to understand the existing setup…

  ⏺ Read(~/.tmux.conf)
    ⎿  Read 120 lines

✻ Thinking… (esc to interrupt)
`;

const IDLE_SCREEN = `
● Done — the parser now handles the version-string command.

╭──────────────────────────────────────────────────────────╮
│ >                                                        │
╰──────────────────────────────────────────────────────────╯
  ? for shortcuts
`;

test('a permission prompt is detected with its question and options', () => {
  const read = readScreen(PERMISSION_PROMPT);
  assert.equal(read.status, 'blocked_permission');
  assert.equal(read.question, 'Do you want to proceed?');
  assert.deepEqual(
    read.options.map((o) => o.key),
    ['1', '2', '3'],
  );
  // Box drawing must not leak into the labels shown on a button.
  assert.equal(read.options[0]?.label, 'Yes');
  assert.equal(read.options[1]?.label, "Yes, and don't ask again for rm commands");
  assert.equal(read.options[0]?.selected, true);
  assert.equal(read.options[1]?.selected, false);
});

test('approve and deny map to the keystrokes that answer the prompt', () => {
  const { approve, deny } = approvalKeys(readScreen(PERMISSION_PROMPT).options);
  assert.equal(approve, '1', 'plain Yes, not "Yes, and don\'t ask again"');
  assert.equal(deny, '3');
});

test('an edit prompt is recognised even though its question names a file', () => {
  const read = readScreen(EDIT_PROMPT);
  assert.equal(read.status, 'blocked_permission');
  assert.equal(read.question, 'Do you want to make this edit to tmux.ts?');
  assert.equal(approvalKeys(read.options).approve, '1');
});

test('the interrupt affordance means working', () => {
  assert.equal(readScreen(WORKING_SCREEN).status, 'working');
});

test('an ordinary prompt box yields no verdict rather than a wrong one', () => {
  // Better to report "unknown" and let hooks or ps decide than to guess idle.
  const read = readScreen(IDLE_SCREEN);
  assert.equal(read.status, undefined);
  assert.deepEqual(read.options, []);
});

test('an empty or unrecognised pane is not mistaken for a prompt', () => {
  assert.equal(readScreen('').status, undefined);
  assert.equal(readScreen('$ ls -la\ntotal 48\ndrwxr-xr-x  12 k  staff').status, undefined);
});

test('a numbered list in ordinary output does not read as a prompt', () => {
  // No permission wording and no question mark, so it must not trigger.
  const output = `
Here are the steps:
  1. Install the hooks
  2. Restart the agent
  3. Watch the panel
`;
  assert.equal(readScreen(output).status, undefined);
});

test('approvalKeys stays silent when no option is clearly affirmative', () => {
  const { approve, deny } = approvalKeys([
    { key: '1', label: 'Pick a different model', selected: true },
    { key: '2', label: 'Change the plan', selected: false },
  ]);
  assert.equal(approve, undefined);
  assert.equal(deny, undefined);
});
