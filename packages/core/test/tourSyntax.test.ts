import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/tourDiff.ts';
import { highlight, rowTokens } from '../src/tourSyntax.ts';

const text = (tokens: [string, string?][]): string => tokens.map((t) => t[0]).join('');
const colorOf = (tokens: [string, string?][] | undefined, word: string): string | undefined =>
  tokens?.find((t) => t[0].includes(word))?.[1];

test('each row gets its own side of the file, a comment across lines coloured as one', async () => {
  const diff = [
    'diff --git a/a.go b/a.go',
    '--- a/a.go',
    '+++ b/a.go',
    '@@ -1,4 +1,4 @@',
    ' /* opened here',
    '-old := 1',
    '+fresh := 2',
    '    closed here */',
    ' func f() {}',
  ].join('\n');
  const [file] = parseDiff(diff);
  const tokens = await rowTokens(file!);
  assert.deepEqual(
    tokens.map(text),
    file!.rows.map((r) => r.text),
  );
  // Line 3 of either side is still inside the comment, though it opens no comment itself.
  const comment = colorOf(tokens[0], 'opened');
  assert.ok(comment);
  assert.equal(colorOf(tokens[3], 'closed'), comment);
  assert.notEqual(colorOf(tokens[4], 'func'), comment);
});

test('a language Shiki is not given, or a file too long to colour (generated code), stays plain', async () => {
  const [file] = parseDiff(['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'));
  assert.deepEqual(await rowTokens(file!), [[['a']], [['b']]]);
  const long = Array.from({ length: 20_001 }, (_, i) => `x := ${i}`);
  assert.deepEqual(await highlight('long.go', long), long.map((line) => [[line]]));
});

test('a file longer than a chunk is coloured through the cut', async () => {
  const lines = [...Array.from({ length: 199 }, (_, i) => `x := ${i}`), '/* opened before the cut', 'closed after it */', 'func f() {}'];
  const tokens = await highlight('a.go', lines);
  assert.equal(tokens.length, lines.length);
  assert.equal(colorOf(tokens[200], 'closed'), colorOf(tokens[199], 'opened'));
  assert.notEqual(colorOf(tokens[201], 'func'), colorOf(tokens[199], 'opened'));
});
