import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-merged-'));
process.env.FLEETWOOD_HOME = home;
const { markDeployed, loadMarks, unmarkDeployed } = await import('../src/deployMarks.ts');
const { MERGED_FILE } = await import('../src/paths.ts');

test('a hand-mark survives a reload, and can be taken back', async () => {
  assert.equal((await loadMarks()).size, 0);

  await markDeployed('bigbluedisco/atlas#3676', 1_700_000_000);
  await markDeployed('bigbluedisco/reflow#10397', 1_700_000_001);
  const after = await loadMarks();
  // The timestamp is the point: it is what the file is pruned by.
  assert.equal(after.get('bigbluedisco/atlas#3676'), 1_700_000_000);
  assert.equal(after.size, 2);

  await unmarkDeployed('bigbluedisco/atlas#3676');
  assert.deepEqual([...(await loadMarks()).keys()], ['bigbluedisco/reflow#10397']);

  // Unmarking something never marked is a no-op, not a write.
  await unmarkDeployed('bigbluedisco/atlas#1');
  assert.equal((await loadMarks()).size, 1);
});

test('entries older than the cutoff are pruned off disk, not just filtered', async () => {
  // Otherwise the file grows for the lifetime of the install, and widening the
  // lookback window would resurrect marks from months ago.
  const old = 1_600_000_000;
  await markDeployed('bigbluedisco/voyager#1', old);
  await markDeployed('bigbluedisco/voyager#2', old + 10_000);

  const kept = await loadMarks(old + 5_000);
  assert.equal(kept.has('bigbluedisco/voyager#1'), false);
  assert.equal(kept.has('bigbluedisco/voyager#2'), true);

  const onDisk = JSON.parse(await readFile(MERGED_FILE, 'utf8')) as { deployed: Record<string, number> };
  assert.equal('bigbluedisco/voyager#1' in onDisk.deployed, false);
});

test('a corrupt file reads as empty rather than throwing', async () => {
  // A half-written file must not take the pull requests tab down.
  await writeFile(MERGED_FILE, '{ not json', 'utf8');
  assert.equal((await loadMarks()).size, 0);
});
