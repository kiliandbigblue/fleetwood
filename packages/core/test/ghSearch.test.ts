import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ghSearch,
  isRateLimited,
  resetGhSearchGate,
  searchCooldown,
  SEARCH_COOLDOWN_MS,
  SEARCH_GAP_MS,
} from '../src/ghSearch.ts';
import type { GateDeps } from '../src/ghSearch.ts';
import type { RunResult } from '../src/exec.ts';

/** A clock that only moves when something waits on it, so pacing is exact. */
function fakeDeps(reply: (args: string[], at: number) => RunResult): GateDeps & {
  starts: number[];
  peak: number;
} {
  let clock = 1_000_000;
  let live = 0;
  const state = {
    starts: [] as number[],
    peak: 0,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    exec: async (args: string[]): Promise<RunResult> => {
      state.starts.push(clock);
      live += 1;
      state.peak = Math.max(state.peak, live);
      await Promise.resolve();
      live -= 1;
      // A call takes time; the gap is measured from starts, so this must not
      // be the thing that creates the spacing.
      clock += 10;
      return reply(args, clock);
    },
  };
  return state;
}

const okRun = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

const limitedRun: RunResult = {
  code: 1,
  stdout: '',
  stderr:
    'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
};

test('a burst of searches leaves one at a time, spaced', async () => {
  resetGhSearchGate();
  const deps = fakeDeps(() => okRun('[]'));
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => ghSearch(['search', 'prs', `head:b${n}`], { deps })),
  );

  assert.ok(
    results.every((result) => result.ok),
    'every batch of a paced burst is answered',
  );
  assert.equal(deps.peak, 1, 'never two searches in flight at once');
  assert.equal(deps.starts.length, 5);
  for (let i = 1; i < deps.starts.length; i += 1) {
    const gap = (deps.starts[i] as number) - (deps.starts[i - 1] as number);
    assert.ok(gap >= SEARCH_GAP_MS, `gap ${i} was ${gap}ms, under the ${SEARCH_GAP_MS}ms floor`);
  }
});

test('a secondary-limit 403 stands the rest of the burst down instead of re-provoking it', async () => {
  resetGhSearchGate();
  const deps = fakeDeps(() => limitedRun);
  const results = await Promise.all(
    [1, 2, 3, 4].map((n) => ghSearch(['search', 'prs', `head:b${n}`], { deps })),
  );

  assert.equal(deps.starts.length, 1, 'only the call that discovered the limit was spent');
  assert.ok(
    results.every((result) => !result.ok && result.limited),
    'the rest are refused locally, and say why',
  );
});

test('the cooldown lapses, and searches resume', async () => {
  resetGhSearchGate();
  let answer: RunResult = limitedRun;
  const deps = fakeDeps(() => answer);

  assert.equal((await ghSearch(['search', 'prs', 'head:a'], { deps })).limited, true);
  assert.equal((await ghSearch(['search', 'prs', 'head:b'], { deps })).limited, true);
  assert.equal(deps.starts.length, 1);

  await deps.sleep(SEARCH_COOLDOWN_MS);
  answer = okRun('[]');
  assert.equal((await ghSearch(['search', 'prs', 'head:c'], { deps })).ok, true);
  assert.equal(deps.starts.length, 2, 'the call after the cooldown actually ran');
});

test('an ordinary failure is not a rate limit, and costs nobody else their turn', async () => {
  resetGhSearchGate();
  const deps = fakeDeps(() => ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }));
  const first = await ghSearch(['search', 'prs', 'head:a'], { deps });
  const second = await ghSearch(['search', 'prs', 'head:b'], { deps });

  assert.deepEqual([first.ok, first.limited], [false, false]);
  assert.deepEqual([second.ok, second.limited], [false, false]);
  assert.equal(deps.starts.length, 2, 'a 404 does not stand the next search down');
  assert.equal(searchCooldown(deps.now()), 0);
});

test('only the wordings that pacing can fix count as a rate limit', () => {
  assert.equal(isRateLimited(limitedRun), true);
  assert.equal(
    isRateLimited({ code: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user' }),
    true,
  );
  // A plain 403 is a permission problem: waiting ninety seconds will not help,
  // and standing every other search down for it would be a self-inflicted outage.
  assert.equal(
    isRateLimited({ code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }),
    false,
  );
  assert.equal(isRateLimited(okRun('[]')), false);
});
