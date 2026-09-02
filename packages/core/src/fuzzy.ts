/*
 * Subsequence matching, in one leaf module.
 *
 * Pure string rules with no `node:` imports, for the reason `naming.ts` has
 * none: both front ends need this, and the renderer cannot reach anything that
 * pulls in `node:fs` without taking the bundle down.
 *
 * The lists this ranks are the ones you steer with the keyboard — the repo step
 * of the new-task flow, the repo picker behind `+ repo`. A substring filter was
 * what those had, and a substring filter is the one that makes you remember how
 * a repo is spelled: `fltwd` found nothing, `orders-dual` found nothing in
 * `feature/orders-dual-write`. What you actually remember is the letters, in
 * order, with the middle missing.
 */

/** A match, scored: 16 a character, so the bonuses below stay meaningful. */
const MATCH = 16;
/** Landing on a word start. What makes `pg` find `proto-go` over `pnpm-lock`. */
const BOUNDARY = 8;
/** Landing right after the previous match — a run beats the same letters spread. */
const CONSECUTIVE = 8;
/** Per character skipped, so the tightest of several possible matches wins. */
const GAP = 1;
/**
 * How far a first match may drift before the leading gap stops counting.
 *
 * Uncapped, a long path outscored nothing at all: `~/projects/very/deep/atlas`
 * paid thirty points for where it happened to sit on disk.
 */
const LEAD_CAP = 12;

const SEPARATOR = /[^\p{L}\p{N}]/u;

/**
 * Whether position `at` starts a word: the front, after a separator, or the
 * upper half of a camelCase seam.
 */
function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text[at - 1] as string;
  if (SEPARATOR.test(before)) return true;
  const here = text[at] as string;
  return before === before.toLowerCase() && here !== here.toLowerCase();
}

/**
 * How well `candidate` matches `query`, or undefined if it does not at all.
 *
 * Every query character has to appear, in order; the score says how tightly.
 * Exact rather than greedy — a forward scan taking the first occurrence of each
 * letter gets `oduw` against `orders-dual-write` wrong, spending the `d` on
 * `orders` and then having no `u` left to find. Candidates are repo names and
 * branches, so the quadratic inner loop is over a few dozen characters.
 *
 * An empty query matches everything at zero, which is what leaves an unfiltered
 * list in the order it was given.
 */
export function fuzzyScore(candidate: string, query: string): number | undefined {
  const needle = query.toLowerCase();
  if (needle.length === 0) return 0;
  const hay = candidate.toLowerCase();
  if (needle.length > hay.length) return undefined;

  // `best[j]`: the best score for the query so far, with its last character
  // matched at candidate position `j`. Undefined where that cannot happen.
  let best: Array<number | undefined> = new Array(hay.length).fill(undefined);
  for (let i = 0; i < needle.length; i++) {
    const next: Array<number | undefined> = new Array(hay.length).fill(undefined);
    let any = false;
    for (let j = i; j < hay.length; j++) {
      if (hay[j] !== needle[i]) continue;
      const here = MATCH + (isBoundary(candidate, j) ? BOUNDARY : 0);
      if (i === 0) {
        next[j] = here - Math.min(j, LEAD_CAP) * GAP;
        any = true;
        continue;
      }
      let from: number | undefined;
      for (let k = i - 1; k < j; k++) {
        const previous = best[k];
        if (previous === undefined) continue;
        const gap = j - k - 1;
        const score = previous + here + (gap === 0 ? CONSECUTIVE : -gap * GAP);
        if (from === undefined || score > from) from = score;
      }
      if (from !== undefined) {
        next[j] = from;
        any = true;
      }
    }
    // Nowhere left to put this character: the rest of the query cannot land.
    if (!any) return undefined;
    best = next;
  }

  let total: number | undefined;
  for (const score of best) {
    if (score !== undefined && (total === undefined || score > total)) total = score;
  }
  return total;
}

/**
 * The matches, best first.
 *
 * Ties break on the shorter candidate and then on the original order, so the
 * list never reshuffles under the cursor between two keystrokes that score the
 * same. An empty query is the whole list, untouched — ranking an unfiltered list
 * would answer a question nobody asked.
 */
export function fuzzyRank<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (query.trim().length === 0) return [...items];
  const scored: Array<{ item: T; score: number; length: number; at: number }> = [];
  items.forEach((item, at) => {
    const candidate = text(item);
    const score = fuzzyScore(candidate, query.trim());
    if (score !== undefined) scored.push({ item, score, length: candidate.length, at });
  });
  scored.sort((a, b) => b.score - a.score || a.length - b.length || a.at - b.at);
  return scored.map((s) => s.item);
}
