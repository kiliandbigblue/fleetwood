import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-notes-'));
process.env.FLEETWOOD_HOME = home;
const { readNotes, writeNotes } = await import('../src/notes.ts');
const { describeNotes } = await import('../src/notesFormat.ts');
const { NOTES_FILE } = await import('../src/paths.ts');

test('no file reads as empty, never as an error', async () => {
  assert.equal(await readNotes(), '');
});

test('what is written comes back exactly, trailing newline included', async () => {
  const text = '## power off\n- notes-tab: drawer done, css left\n\n';
  const result = await writeNotes(text);
  assert.equal(result.ok, true);
  assert.equal(await readFile(NOTES_FILE, 'utf8'), text);
  assert.equal(await readNotes(), text);
});

test('blank removes the file rather than leaving an empty one', async () => {
  await writeNotes('something');
  const result = await writeNotes('  \n\n');
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'cleared notes');
  await assert.rejects(stat(NOTES_FILE));
  assert.equal(await readNotes(), '');
});

test('a description is the first real line and a count of the rest', () => {
  assert.deepEqual(describeNotes(''), { head: '', lines: 0 });
  assert.deepEqual(describeNotes('\n\n  \n'), { head: '', lines: 0 });
  assert.deepEqual(describeNotes('# power off 21/09\n\n- atlas: waiting on review\n- fw: ship drawer\n'), {
    head: 'power off 21/09',
    lines: 3,
  });
  // A list marker on the first line is not the note's title either.
  assert.deepEqual(describeNotes('- first thing\n- second'), { head: 'first thing', lines: 2 });
});
