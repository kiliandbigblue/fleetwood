import { run } from './exec.ts';
import type { RunResult } from './exec.ts';

/*
 * The one door every `gh search` goes through.
 *
 * GitHub's search API is not rate-limited like the rest of it. The core API
 * allows 5,000 calls an hour; search allows 30 a minute, and on top of that an
 * unpublished *secondary* limit that answers 403 to a burst of concurrent
 * requests well before either number is reached. A poll that stays comfortably
 * inside both published budgets can still be refused for firing its calls at
 * once, which is exactly what happened here: one 60s tick fanned five branch
 * batches out through `Promise.all` while the open-PR search fired its two on
 * the same tick, and seven simultaneous searches was enough.
 *
 * What makes that failure worth a module rather than a retry is where it lands.
 * A refused search is indistinguishable from a branch having no pull request,
 * so the honest answer is `degraded` — and a degraded answer means a task shows
 * no pull requests at all. Worse, the next tick repeats the identical burst, so
 * the limit is re-tripped before it lapses and the fleet stays blank rather
 * than recovering.
 *
 * So: one call at a time, spaced, and a secondary-limit 403 stands everyone
 * down for a cooldown instead of being re-provoked a minute later. This is a
 * process-wide gate on purpose — the point is the total rate leaving the
 * machine, which no per-caller pacing can bound.
 */

/** Minimum gap between two searches leaving this process. 30/min is the published ceiling. */
export const SEARCH_GAP_MS = 2_000;

/**
 * How long a secondary-limit 403 stands searches down.
 *
 * Longer than the poll interval on purpose. A cooldown shorter than the tick
 * would let the next tick walk straight back into the limit, which is the loop
 * this exists to break.
 */
export const SEARCH_COOLDOWN_MS = 90_000;

/**
 * GitHub's wording for the limit that pacing fixes.
 *
 * Matched rather than inferred from the 403 alone: a plain 403 is a permission
 * problem, and standing every search down for a minute and a half is the wrong
 * response to a token that will never be allowed to read that repo.
 */
export function isRateLimited(result: RunResult): boolean {
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  return /secondary rate limit|\bAPI rate limit exceeded\b|\bRetry-After\b/i.test(text);
}

interface Gate {
  /** Resolves when the previous search has finished and its gap has elapsed. */
  chain: Promise<void>;
  /** When the last search started, so the gap is measured from starts, not ends. */
  lastStart: number;
  /** Epoch ms before which no search is attempted at all. */
  coolUntil: number;
}

const gate: Gate = { chain: Promise.resolve(), lastStart: 0, coolUntil: 0 };

/** Test seam: the clock and the sleep, so pacing can be asserted without waiting. */
export interface GateDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  exec: (args: string[], timeoutMs: number) => Promise<RunResult>;
}

const realDeps: GateDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exec: (args, timeoutMs) => run('gh', args, { timeoutMs }),
};

export interface GhSearchResult {
  /** False for any failure, refused or otherwise — the caller must not read `stdout`. */
  ok: boolean;
  stdout: string;
  /** True when the failure was a rate limit rather than a broken query or token. */
  limited: boolean;
}

/**
 * Run one `gh search`, serialised behind every other search in this process.
 *
 * Waiting is the feature. Five batches take ten seconds to leave, which is
 * nothing against a 60s poll and is the difference between five answers and
 * none.
 */
export async function ghSearch(
  args: string[],
  options: { timeoutMs?: number; deps?: GateDeps } = {},
): Promise<GhSearchResult> {
  const deps = options.deps ?? realDeps;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const turn = gate.chain.then(async (): Promise<GhSearchResult> => {
    // Cooling down: refuse locally rather than spend the call on being refused.
    // Same shape as a real refusal, so callers need no second branch.
    if (deps.now() < gate.coolUntil) return { ok: false, stdout: '', limited: true };

    const wait = gate.lastStart + SEARCH_GAP_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);

    gate.lastStart = deps.now();
    const result = await deps.exec(args, timeoutMs);
    if (isRateLimited(result)) {
      gate.coolUntil = deps.now() + SEARCH_COOLDOWN_MS;
      return { ok: false, stdout: '', limited: true };
    }
    return { ok: result.code === 0, stdout: result.stdout, limited: false };
  });

  // The chain must survive a thrown turn, or one failure wedges every later
  // search behind a rejected promise.
  gate.chain = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** Drop the gate's state. For tests, and for a config reload that changes nothing else. */
export function resetGhSearchGate(): void {
  gate.chain = Promise.resolve();
  gate.lastStart = 0;
  gate.coolUntil = 0;
}

/** Whether searches are currently stood down, and until when. */
export function searchCooldown(now = Date.now()): number {
  return Math.max(0, gate.coolUntil - now);
}
