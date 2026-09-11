import type { PullRequest } from './github.ts';
import type { TaskRepo } from './task.ts';
import type { TaskPr } from './taskPrs.ts';

/*
 * How far along a task is — the one thing the mark beside its name says.
 *
 * A leaf module for the same reason `taskView.ts` is one: both front ends draw
 * this, and `task.ts` reaches for `node:fs` and tmux, which fails the renderer
 * bundle. Type-only imports, so nothing above comes with them.
 *
 * This replaces what the dot used to carry, which was not progress at all but an
 * urgency rank — a blocked agent over failing checks over uncommitted work over
 * an approval. That rank answers "which card do I open next", and it answers it
 * well, but it was the only thing the mark said, so the two questions a list of
 * tasks is actually scanned for — how far is this, and is it finished — had no
 * answer anywhere on the card. Worse, the two orders disagree: uncommitted work
 * outranked an approval, so a task one click from merging drew louder than one
 * still being written. `worstState` is kept, for the session cards where urgency
 * *is* the question; the task dot is progress now, and nothing else.
 */

/** Where a task has got to. Ordered, and the order is the whole type. */
export type TaskStatus = 'not-started' | 'wip' | 'in-review' | 'done';

/** Weakest first — a task is the weakest thing in it, so this is the comparison. */
const RANK: Record<TaskStatus, number> = { 'not-started': 0, wip: 1, 'in-review': 2, done: 3 };

export const STATUS_LABEL: Record<TaskStatus, string> = {
  'not-started': 'not started',
  wip: 'wip',
  'in-review': 'in review',
  done: 'done',
};

/**
 * What one pull request says about the work on its branch.
 *
 * Draft is the line between wip and in review, rather than the review decision:
 * "awaiting review or higher" is one state from the reviewer's side and four from
 * GitHub's — no decision yet, review required, approved, changes requested — and
 * folding those into separate rungs is how the old mark became unreadable. A
 * pull request you have marked ready is a pull request you are done writing. The
 * decision and the checks still say their own words on the row; they are just not
 * what the progress mark is measuring.
 *
 * `state` is absent on anything that came from a search rather than the repo/ref
 * lookup, and every search this codebase makes is filtered to open pull requests
 * — so absent means open.
 */
export function prStatus(pr: Pick<PullRequest, 'state' | 'isDraft'>): TaskStatus {
  if (pr.state === 'MERGED') return 'done';
  return pr.isDraft ? 'wip' : 'in-review';
}

/**
 * What a worktree says about itself, with no GitHub in it at all.
 *
 * This is the whole answer for the local mode — a personal task that lands
 * straight on `main` and never opens a pull request — and the fallback for any
 * repo in a task that has not pushed yet.
 *
 * The hard case is the one at the bottom: zero commits ahead of the trunk means
 * either nobody started or the trunk already has the work, and those are the two
 * ends of the task. `everCommitted` is what separates them, and it comes from the
 * branch's own reflog — see `localProgress`. Without it this function would have
 * to call a landed task "not started", which is the exact complaint the whole
 * change exists to answer.
 *
 * An unknown `ahead` — no trunk to compare against — never reaches `done`. The
 * work may well have landed; nothing here can show that it did, and claiming it
 * on a guess is worse than reading one rung low.
 */
export function repoStatus(repo: Pick<TaskRepo, 'dirty' | 'ahead' | 'everCommitted'>): TaskStatus {
  if (repo.dirty > 0) return 'wip';
  if (repo.ahead === undefined) return repo.everCommitted ? 'wip' : 'not-started';
  if (repo.ahead > 0) return 'wip';
  return repo.everCommitted ? 'done' : 'not-started';
}

/**
 * The status of a whole task: the weakest thing in it, once the empties are out.
 *
 * Two rules, and both of them are about what *not* to count.
 *
 * **A repo with a pull request is described by that pull request, not by its
 * worktree.** The old mark ranked uncommitted changes above an approval, so a
 * stray edit in a branch already up for review dragged the card backwards. The
 * dirty count still says `3 dirty` on its own row, where it is a fact about a
 * directory rather than a claim about the task.
 *
 * **A repo nobody has touched does not hold a finished task open.** Adding a repo
 * to a task and never editing it is ordinary — you thought the change would reach
 * there and it did not — and a strict weakest-wins would leave such a task reading
 * "not started" forever after everything else had merged. So `not-started` only
 * survives when it is *all* there is, which is also exactly when it is true.
 *
 * Nothing else is dropped. One draft among four merged pull requests is a task
 * still being written, and it reads `wip`.
 *
 * `prs` being `undefined` is the first fetch still out, and is answered from the
 * worktrees alone rather than withheld. The reading settles upward as the fetch
 * lands — a branch with commits reads `wip` and becomes `in review` — so the mark
 * is never briefly more finished than the task is.
 */
export function taskStatus(repos: TaskRepo[], prs: TaskPr[] | undefined): TaskStatus {
  const open = prs ?? [];
  const rungs: TaskStatus[] = [];

  for (const repo of repos) {
    const mine = open.filter((pr) => pr.repoName === repo.name);
    if (mine.length > 0) rungs.push(weakest(mine.map(prStatus)));
    else rungs.push(repoStatus(repo));
  }

  // A pull request on the task's branch in a repo the folder does not hold — the
  // `task` via. It is the task's work as much as any worktree's, and no worktree
  // here will ever speak for it.
  for (const pr of open) {
    if (pr.repoName === undefined || !repos.some((r) => r.name === pr.repoName)) {
      rungs.push(prStatus(pr));
    }
  }

  const moved = rungs.filter((rung) => rung !== 'not-started');
  if (moved.length === 0) return 'not-started';
  return weakest(moved);
}

function weakest(rungs: TaskStatus[]): TaskStatus {
  return rungs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}
