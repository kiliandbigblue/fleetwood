import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorArgs, gumColors } from '../src/newTask.ts';

/*
 * The two bits of `fw new` that are decisions rather than plumbing: which flag
 * opens an editor on a line, and which style flags a gum subcommand will accept.
 * Both fail the same way in a tmux popup — a process that exits before you can
 * read why — so they are checked here instead.
 */

test('vi-family editors are opened on the goal line', () => {
  assert.deepEqual(editorArgs('nvim', 12), ['+12']);
  assert.deepEqual(editorArgs('vim', 12), ['+12']);
  assert.deepEqual(editorArgs('/opt/homebrew/bin/nvim', 7), ['+7']);
});

test('an editor that would treat +N as a filename gets the file alone', () => {
  // `code +12 TASK.md` creates a file called `+12`, which is worse than
  // opening at the top of the one you asked for.
  assert.deepEqual(editorArgs('code', 12), []);
  assert.deepEqual(editorArgs('subl', 12), []);
});

test('every gum subcommand gets a header colour, since all three have one', () => {
  for (const sub of ['filter', 'choose', 'input']) {
    assert.ok(
      gumColors(sub).some((flag) => flag.startsWith('--header.foreground=')),
      `${sub} should be given a header colour`,
    );
  }
});

test('style flags stay inside the subcommand that defines them', () => {
  // gum exits non-zero on a flag its subcommand does not know, which in a popup
  // is a form that vanishes. `--selected` is choose-only, `--match` filter-only.
  assert.ok(gumColors('choose').some((f) => f.startsWith('--selected.foreground=')));
  assert.ok(!gumColors('input').some((f) => f.startsWith('--selected.foreground=')));
  assert.ok(gumColors('filter').some((f) => f.startsWith('--match.foreground=')));
  assert.ok(!gumColors('choose').some((f) => f.startsWith('--match.foreground=')));
  assert.ok(gumColors('input').some((f) => f.startsWith('--prompt.foreground=')));
});

test('filter is not given a cursor colour, because it has no cursor', () => {
  // The one that actually bit: `gum filter` draws a prompt and a match, not a
  // pointer, and rejects `--cursor.foreground`. It is the *first* question the
  // form asks, so getting this wrong is a popup that never appears at all.
  assert.ok(!gumColors('filter').some((f) => f.startsWith('--cursor.foreground=')));
  assert.ok(gumColors('choose').some((f) => f.startsWith('--cursor.foreground=')));
  assert.ok(gumColors('input').some((f) => f.startsWith('--cursor.foreground=')));
});
