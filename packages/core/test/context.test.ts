import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readContextTokens, resetContextCache } from '../src/context.ts';
import { contextBand, describeContext, formatContextTokens } from '../src/contextFormat.ts';

/**
 * One assistant record, shaped as Claude Code writes them.
 *
 * The usage object is trimmed from a live transcript: the three token fields
 * this reads, plus the ones beside them that it must ignore.
 */
function turn(
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-11T09:00:00.000Z',
    sessionId: 's1',
    ...extra,
    message: { model: 'claude-opus-5', usage, ...((extra.message as object) ?? {}) },
  });
}

const FULL = {
  input_tokens: 2,
  cache_creation_input_tokens: 558,
  cache_read_input_tokens: 270_911,
  output_tokens: 479,
  output_tokens_details: { thinking_tokens: 0 },
  service_tier: 'standard',
};

async function transcript(...lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fw-context-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  resetContextCache();
  return path;
}

test('context is the whole prompt: fresh input, cache reads and cache writes', async () => {
  // The split between the three is a billing detail; the conversation is the
  // same length however much of it came back from cache.
  const path = await transcript(turn(FULL));
  assert.equal(await readContextTokens(path), 2 + 558 + 270_911);
});

test('the newest turn wins, because context is a level and not a sum', async () => {
  const path = await transcript(
    turn({ ...FULL, cache_read_input_tokens: 100_000 }),
    turn({ ...FULL, cache_read_input_tokens: 200_000 }),
    turn({ ...FULL, cache_read_input_tokens: 300_000 }),
  );
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);
  // And reading twice cannot drift — the bug class the old spend fold existed
  // to avoid, which this shape simply does not have.
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);
});

test('a compaction shows up as the number falling', async () => {
  // Nothing special is done for it: the turn after a compact genuinely carries
  // less, so the level reports less.
  const path = await transcript(
    turn({ ...FULL, cache_read_input_tokens: 700_000 }),
    turn({ input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 41_000 }),
  );
  assert.equal(await readContextTokens(path), 41_012);
});

test('subagent turns are skipped — that context is not what this pane re-reads', async () => {
  const path = await transcript(
    turn({ ...FULL, cache_read_input_tokens: 300_000 }),
    turn({ ...FULL, cache_read_input_tokens: 20_000 }, { isSidechain: true }),
  );
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);
});

test('locally generated messages carry no context', async () => {
  const synthetic = JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', usage: { input_tokens: 5, cache_read_input_tokens: 9 } },
  });
  const path = await transcript(turn({ ...FULL, cache_read_input_tokens: 300_000 }), synthetic);
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);
});

test('user records and other lines are passed over, not parsed for tokens', async () => {
  const path = await transcript(
    turn({ ...FULL, cache_read_input_tokens: 300_000 }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'next question' } }),
    JSON.stringify({ type: 'summary', summary: 'a compacted history' }),
  );
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);
});

test('a half-written last line is ignored, and read whole once it grows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-context-'));
  const path = join(dir, 'session.jsonl');
  const whole = turn({ ...FULL, cache_read_input_tokens: 300_000 });
  const next = turn({ ...FULL, cache_read_input_tokens: 400_000 });
  await writeFile(path, `${whole}\n${next.slice(0, 40)}`, 'utf8');
  resetContextCache();
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);

  await writeFile(path, `${whole}\n${next}\n`, 'utf8');
  assert.equal(await readContextTokens(path), 2 + 558 + 400_000);
});

test('an unchanged file is not re-read, and a shrunken one is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-context-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, `${turn({ ...FULL, cache_read_input_tokens: 300_000 })}\n`, 'utf8');
  resetContextCache();
  assert.equal(await readContextTokens(path), 2 + 558 + 300_000);

  // `/clear` reuses the path with a shorter file. Size is the validator, so a
  // smaller file is a different file and gets read again.
  await writeFile(path, `${turn({ input_tokens: 1, cache_read_input_tokens: 1_000 })}\n`, 'utf8');
  assert.equal(await readContextTokens(path), 1_001);
});

test('nothing readable reads as unknown rather than as zero', async () => {
  // Every failure collapses to undefined on purpose: the column has an empty
  // state, and a 0 in that slot would be read as "this agent is fresh".
  assert.equal(await readContextTokens(join(tmpdir(), 'fw-context-nope', 'gone.jsonl')), undefined);
  assert.equal(await readContextTokens(await transcript()), undefined);
  assert.equal(await readContextTokens(await transcript('not json at all')), undefined);
  assert.equal(
    await readContextTokens(await transcript(JSON.stringify({ type: 'user', message: {} }))),
    undefined,
  );
  // A turn whose usage object is present but empty has no context to report.
  assert.equal(await readContextTokens(await transcript(turn({}))), undefined);
});

test('magnitudes, not token counts', () => {
  assert.equal(formatContextTokens(38_412), '38k');
  assert.equal(formatContextTokens(412_345), '412k');
  // The extra digit past a million is the difference between "large" and
  // "about to compact".
  assert.equal(formatContextTokens(1_020_000), '1.0M');
  assert.equal(formatContextTokens(967_000), '967k');
});

test('bands are inclusive of their threshold, and quiet below the first', () => {
  const at = { warnTokens: 250_000, criticalTokens: 450_000 };
  assert.equal(contextBand(80_000, at), undefined);
  assert.equal(contextBand(249_999, at), undefined);
  assert.equal(contextBand(250_000, at), 'warn');
  assert.equal(contextBand(449_999, at), 'warn');
  assert.equal(contextBand(450_000, at), 'critical');
});

test('the hover says the consequence, and only claims a multiple when there is one', () => {
  assert.match(describeContext(412_000), /412k of context/);
  assert.match(describeContext(412_000), /about 10x a fresh session/);
  assert.match(describeContext(412_000), /\/clear/);
  // Just above the baseline, "1x" would be noise.
  assert.equal(describeContext(45_000).includes('a fresh session'), false);
});
