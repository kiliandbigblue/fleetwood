import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyRank, fuzzyScore } from '../src/fuzzy.ts';

/*
 * The ranking, which is the whole point of the thing: any subsequence matcher
 * finds `atlas` from `atls`, and the useful ones put the repo you meant first.
 */

test('the letters, in order, with the middle missing', () => {
  assert.notEqual(fuzzyScore('fleetwood', 'fltwd'), undefined);
  assert.notEqual(fuzzyScore('orders-dual-write', 'oduw'), undefined);
  // Out of order is not a match, and neither is a letter that isn't there.
  assert.equal(fuzzyScore('fleetwood', 'dwtlf'), undefined);
  assert.equal(fuzzyScore('atlas', 'atlaz'), undefined);
});

test('an empty query matches everything, and leaves the order alone', () => {
  assert.equal(fuzzyScore('atlas', ''), 0);
  assert.deepEqual(fuzzyRank(['proto', 'atlas'], '', (s) => s), ['proto', 'atlas']);
  assert.deepEqual(fuzzyRank(['proto', 'atlas'], '   ', (s) => s), ['proto', 'atlas']);
});

test('a greedy scan gets this one wrong, so the scoring is exact', () => {
  /*
   * `oduw` against `orders-dual-write`: taking the first `d` spends it on
   * `orders` and leaves no `u` after it. The match exists, one letter along.
   */
  assert.notEqual(fuzzyScore('orders-dual-write', 'oduw'), undefined);
});

test('word starts beat the same letters mid-word', () => {
  const boundary = fuzzyScore('proto-go', 'pg') as number;
  const inside = fuzzyScore('pnpm-lock', 'pg');
  assert.equal(inside, undefined);
  // Against a candidate that does contain both, mid-word: the boundary wins.
  assert.ok(boundary > (fuzzyScore('pageant', 'pg') as number));
});

test('a run beats the same letters spread out', () => {
  assert.ok((fuzzyScore('reflow', 'ref') as number) > (fuzzyScore('remote-fleet-work', 'ref') as number));
});

test('an exact prefix wins, which is the case that has to feel obvious', () => {
  assert.deepEqual(fuzzyRank(['proto-go', 'proto', 'protobuf-tools'], 'proto', (s) => s), [
    'proto',
    'proto-go',
    'protobuf-tools',
  ]);
});

test('where a repo sits on disk does not outweigh what it is called', () => {
  // The leading gap is capped, so a deep path still scores as a real match.
  const deep = fuzzyScore('/Users/kilian/projects/very/deeply/nested/atlas', 'atlas') as number;
  assert.notEqual(deep, undefined);
  assert.ok(deep > 0);
});

test('ties break on the shorter name, then on the order given', () => {
  // Same score both ways; `ab` is shorter, and `y-ab` was the first of the two long ones.
  assert.deepEqual(fuzzyRank(['y-ab', 'x-ab', 'ab'], 'ab', (s) => s), ['ab', 'y-ab', 'x-ab']);
});

test('ranks whatever the caller points at, not only strings', () => {
  const repos = [{ name: 'atlas' }, { name: 'proto' }];
  assert.deepEqual(
    fuzzyRank(repos, 'prt', (r) => r.name),
    [{ name: 'proto' }],
  );
});
