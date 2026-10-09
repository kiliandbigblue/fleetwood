import { basename } from 'node:path';
import type { ActionResult } from './actions.ts';
import { fetchPr, prKey } from './github.ts';
import type { PullRequest } from './github.ts';
import { parsePrRef } from './prRef.ts';
import { resolveRepo } from './repoIndex.ts';
import { createTask, listTasks, startTaskSession } from './task.ts';
import { fetchPrBranch, forkPrBranch } from './worktree.ts';

export interface OpenPrOptions {
  /** Create the task but leave focus where it is. */
  background?: boolean;
}

/**
 * Open a PR as a task: the one already holding its branch, or a new one.
 *
 * A task rather than a session of its own, so a pull request gets what every
 * piece of work gets — the card, its pull request row, the review — instead of a
 * second kind of card that has to grow each of those again.
 */
async function openPr(pr: PullRequest, options: OpenPrOptions): Promise<ActionResult> {
  const local = await resolveRepo(pr.repo);
  if (!local) {
    return { ok: false, detail: `${pr.repo} is not cloned under your project roots — clone it first` };
  }

  // Before the fetch: a fork's `pr-N` cannot be fetched into while a worktree has it out.
  const held = [pr.branch, forkPrBranch(pr.number)];
  const existing = (await listTasks()).find((t) =>
    t.repos.some((r) => r.repo === pr.repo && r.branch !== undefined && held.includes(r.branch)),
  );
  if (existing) {
    if (options.background) {
      return { ok: true, detail: `${prKey(pr.repo, pr.number)} is already task ${existing.slug}` };
    }
    const started = await startTaskSession(existing.slug);
    return { ok: started.ok, detail: `focused task ${existing.slug}` };
  }

  const fetched = await fetchPrBranch(local.path, pr.number, pr.branch);
  if (!fetched.ok) return fetched;

  const result = await createTask({
    type: 'pr',
    microservice: basename(pr.repo),
    summary: pr.title,
    goal: pr.url,
    repos: [local.path],
    branch: fetched.branch,
    background: options.background,
  });
  return { ok: result.ok, detail: result.detail };
}

/**
 * Open a pull request named by a URL or `owner/repo#123`, listed or not.
 *
 * The lists fleetwood draws are two searches — yours, and the ones asking for
 * your review — so every pull request outside them was unreachable from the
 * app: someone links you one in Slack, and there was nowhere to put it. This is
 * the door for that, and both front ends go through it so a URL means the same
 * thing in the palette as it does in `fw open-pr`.
 */
export async function openPrRef(ref: string, options: OpenPrOptions = {}): Promise<ActionResult> {
  const parsed = parsePrRef(ref);
  if (!parsed) {
    return { ok: false, detail: `could not read a pull request out of "${ref.trim()}"` };
  }

  // Looked up rather than opened straight from the number, for the head branch.
  // Without one `fetchPrBranch` falls back to fetching `pull/N/head` into
  // a local `pr-N`, which reads fine but is not the branch the pull request is
  // on — so nothing could be pushed back from the review.
  const pr = await fetchPr(parsed.repo, parsed.number);
  if (!pr) {
    return {
      ok: false,
      detail: `gh could not read ${prKey(parsed.repo, parsed.number)} — check the link, and \`gh auth status\``,
    };
  }
  return openPr(pr, options);
}

