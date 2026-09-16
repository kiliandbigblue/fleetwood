import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrRef } from '../src/prRef.ts';

const atlas = { repo: 'bigbluedisco/atlas', number: 4821 };

test('reads the short form', () => {
  assert.deepEqual(parsePrRef('bigbluedisco/atlas#4821'), atlas);
});

test('reads a pull request URL, with or without the scheme', () => {
  assert.deepEqual(parsePrRef('https://github.com/bigbluedisco/atlas/pull/4821'), atlas);
  assert.deepEqual(parsePrRef('github.com/bigbluedisco/atlas/pull/4821'), atlas);
});

test('reads the URL a link copied mid-review carries', () => {
  // The three shapes an actual paste comes in: a tab under the pull request, a
  // comment anchor, and the tracking query GitHub's own notifications add.
  assert.deepEqual(parsePrRef('https://github.com/bigbluedisco/atlas/pull/4821/files'), atlas);
  assert.deepEqual(
    parsePrRef('https://github.com/bigbluedisco/atlas/pull/4821#discussion_r1234567'),
    atlas,
  );
  assert.deepEqual(
    parsePrRef('https://github.com/bigbluedisco/atlas/pull/4821?notification_referrer_id=NT_kw'),
    atlas,
  );
});

test('the host is not the repo', () => {
  // The two segments in front of `/pull/` are the repo wherever they sit, so an
  // enterprise host works and `github.com/bigbluedisco` is never mistaken for one.
  assert.deepEqual(parsePrRef('https://git.corp.example/bigbluedisco/atlas/pull/4821'), atlas);
});

test('trims what a paste brings with it', () => {
  assert.deepEqual(parsePrRef('  https://github.com/bigbluedisco/atlas/pull/4821\n'), atlas);
});

test('rejects anything that is not a pull request', () => {
  // The palette tests every keystroke, so ordinary typing must not look like one.
  for (const ref of [
    '',
    'atlas',
    'flow-execution-labels',
    'bigbluedisco/atlas',
    '#4821',
    'https://github.com/bigbluedisco/atlas/issues/4821',
    'https://github.com/bigbluedisco/atlas/pull/',
  ]) {
    assert.equal(parsePrRef(ref), undefined, ref);
  }
});
