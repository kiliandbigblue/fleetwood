import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/exec.ts';
import { agentDiff, mergeBase, snapshotTree, wholeDiff } from '../src/tourDiff.ts';
import { checkRecap } from '../src/tourRecap.ts';

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fw-tour-test-')));
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'trunk');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await writeFile(join(dir, 'main.go'), 'package main\n\nfunc main() {\n\trun()\n}\n');
  await writeFile(join(dir, 'old.txt'), 'gone\n');
  await git('add', '-A');
  await git('commit', '-qm', 'first');
  await git('checkout', '-qb', 'feature');
  await writeFile(join(dir, 'main.go'), 'package main\n\nfunc main() {\n\tregister()\n\trun()\n}\n');
  await git('commit', '-qam', 'register');
  // Uncommitted: an edit, a new untracked file and a deletion.
  await writeFile(join(dir, 'consumer.go'), 'package main\n\nfunc register() {}\n');
  await git('rm', '-q', 'old.txt');
  return dir;
}

test('a snapshot holds uncommitted work and leaves the index alone', async () => {
  const dir = await repo();
  const before = (await run('git', ['-C', dir, 'status', '--porcelain'])).stdout;
  const tree = await snapshotTree(dir);
  assert.equal((await run('git', ['-C', dir, 'status', '--porcelain'])).stdout, before);

  const files = await wholeDiff(dir, await mergeBase(dir, 'trunk'), tree);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath['consumer.go']?.status, 'added');
  assert.equal(byPath['old.txt']?.status, 'deleted');
  assert.deepEqual(
    byPath['main.go']?.rows.map((r) => r.kind + r.text),
    [' package main', ' ', ' func main() {', '+\tregister()', ' \trun()', ' }'],
  );
  assert.match(agentDiff(files), /\+ {5}4 \| \tregister\(\)/);
  // Same worktree, same snapshot: the cache key holds.
  assert.equal(await snapshotTree(dir), tree);
  assert.equal(await readFile(join(dir, 'consumer.go'), 'utf8'), 'package main\n\nfunc register() {}\n');
});

test('checkRecap places every changed line once, and collects what was left out', async () => {
  const dir = await repo();
  const files = await wholeDiff(dir, await mergeBase(dir, 'trunk'), await snapshotTree(dir));
  const checked = checkRecap(
    {
      sections: [
        {
          title: 'Register the consumer',
          summary: '',
          changes: [{ path: 'main.go', side: 'new', start: 4, end: 4, show: { start: 3, end: 6 } }],
        },
        {
          title: 'Consumer',
          summary: '',
          // Claims main.go:4 again: the first section keeps it.
          changes: [
            { path: 'consumer.go', side: 'new', start: 1, end: 3 },
            { path: 'main.go', side: 'new', start: 4, end: 4 },
          ],
        },
      ],
    },
    files,
  );
  assert.deepEqual(checked.sections[0]?.files, [{ path: 'main.go', windows: [[2, 5]] }]);
  assert.deepEqual(checked.owners['main.go'], [-1, -1, -1, 0, -1, -1]);
  assert.deepEqual(checked.owners['consumer.go'], [1, 1, 1]);
  const last = checked.sections.at(-1);
  assert.equal(last?.uncovered, true);
  assert.deepEqual(last?.files.map((f) => f.path), ['old.txt']);
  assert.deepEqual(checked.owners['old.txt'], [2]);
});

test('an unclaimed blank line joins the section beside it instead of Not covered', () => {
  const files = [
    {
      path: 'a.go',
      status: 'modified' as const,
      binary: false,
      rows: [
        { kind: '+' as const, new: 1, text: 'one()' },
        { kind: '+' as const, new: 2, text: '' },
        { kind: '+' as const, new: 3, text: 'two()' },
      ],
    },
  ];
  const checked = checkRecap(
    {
      sections: [
        { title: 'a', summary: '', changes: [{ path: 'a.go', side: 'new', start: 1, end: 1 }] },
        { title: 'b', summary: '', changes: [{ path: 'a.go', side: 'new', start: 3, end: 3 }] },
      ],
    },
    files,
  );
  assert.deepEqual(checked.owners['a.go'], [0, 0, 1]);
  assert.equal(checked.sections.length, 2);
});

test('checkRecap refuses a range that names nothing in the diff', async () => {
  const dir = await repo();
  const files = await wholeDiff(dir, await mergeBase(dir, 'trunk'), await snapshotTree(dir));
  assert.throws(
    () => checkRecap({ sections: [{ title: 't', summary: '', changes: [{ path: 'nope.go', side: 'new', start: 1, end: 2 }] }] }, files),
    /nope\.go is not in the diff/,
  );
});

test('checkRecap drops a ref that runs backwards or holds a changed line', () => {
  const files = [
    {
      path: 'a.go',
      status: 'modified' as const,
      binary: false,
      rows: [
        { kind: ' ' as const, old: 1, new: 1, text: 'one()' },
        { kind: '+' as const, new: 2, text: 'two()' },
        { kind: ' ' as const, old: 2, new: 3, text: 'three()' },
      ],
    },
  ];
  const ref = (start: number, end: number) => ({ path: 'a.go', start, end, note: `${start}-${end}` });
  const checked = checkRecap(
    {
      sections: [
        {
          title: 'a',
          summary: '',
          changes: [{ path: 'a.go', side: 'new', start: 2, end: 2 }],
          refs: [ref(1, 1), ref(1, 3), ref(3, 1), ref(3, 3), { path: 'b.go', start: 1, end: 9, note: 'elsewhere' }],
        },
      ],
    },
    files,
  );
  assert.deepEqual(
    checked.sections[0]?.refs.map((r) => r.note),
    ['1-1', '3-3', 'elsewhere'],
  );
});
