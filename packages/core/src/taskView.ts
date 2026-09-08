import { hasDriftedOffBranch } from './naming.ts';
import type { FleetAgent } from './fleet.ts';
import type { Task, TaskRepo } from './task.ts';
import type { BranchVia, TaskPr } from './taskPrs.ts';

/*
 * How a task reads, for both front ends.
 *
 * A leaf module on purpose: `task.ts` reaches for `node:fs` and tmux, which fails
 * the renderer bundle, and these two functions need neither — they only read a
 * `Task` that somebody else assembled. Type-only imports, so nothing above comes
 * with them.
 */

/**
 * Which repo an agent is working in, by its cwd.
 *
 * An agent at the task root belongs to the task as a whole; one inside a repo's
 * worktree belongs to that repo. That distinction is the whole point of the layout,
 * so the UI has to show it rather than lumping every agent together.
 */
export function partitionAgents(
  task: Task,
  agents: FleetAgent[],
): { taskLevel: FleetAgent[]; byRepo: Map<string, FleetAgent[]> } {
  const byRepo = new Map<string, FleetAgent[]>();
  const taskLevel: FleetAgent[] = [];

  for (const agent of agents) {
    const repo = agent.cwd
      ? task.repos.find((r) => agent.cwd === r.path || agent.cwd?.startsWith(`${r.path}/`))
      : undefined;
    if (repo) {
      const list = byRepo.get(repo.name);
      if (list) list.push(agent);
      else byRepo.set(repo.name, [agent]);
    } else {
      taskLevel.push(agent);
    }
  }
  return { taskLevel, byRepo };
}

/**
 * A task's worktrees in one line: how many, and what is off-nominal about them.
 *
 * Written once and printed by both front ends, for the reason the theme is one
 * setting — this panel sits beside the terminal, and `fw task ls` describing the
 * same folder differently is the clash worth ending.
 *
 * It is also the panel's stand-in for the repo rows when they are collapsed, which
 * is why it counts *repos* rather than summing changes: `2 dirty` means two repos
 * want a commit, and that is the thing you would open the rows to find out. A
 * change count would read as `9 dirty` for one busy worktree and say nothing about
 * how many places the work is spread across.
 */
export function repoSummary(repos: TaskRepo[], taskBranch: string): string {
  const dirty = repos.filter((r) => r.dirty > 0).length;
  const off = repos.filter((r) => hasDriftedOffBranch(r.name, r.branch, taskBranch)).length;
  // Worktrees and repos are the same number until a stack makes them differ, and
  // then saying `4 repos` of one repo on four branches is simply wrong — the
  // count is what you open the rows to understand.
  const distinct = new Set(repos.map((r) => r.repo ?? r.name)).size;
  const parts = [`${distinct} repo${distinct === 1 ? '' : 's'}`];
  if (repos.length !== distinct) parts.push(`${repos.length} worktrees`);
  if (dirty > 0) parts.push(`${dirty} dirty`);
  if (off > 0) parts.push(`${off} off-branch`);
  return parts.join(' · ');
}

/**
 * A task's open pull requests in one line: how many, and what they are waiting on.
 *
 * The same shape as `repoSummary` and for the same reason — one sentence, both
 * front ends. Only the two states that ask something of you get counted: a red
 * check is work, an approval is a merge you have not done yet. Everything else
 * is a pull request quietly waiting for a reviewer, which the count already says.
 */
export function prSummary(prs: TaskPr[]): string {
  const failing = prs.filter((pr) => pr.checks === 'failing').length;
  const approved = prs.filter((pr) => pr.reviewDecision === 'APPROVED').length;
  const parts = [`${prs.length} open`];
  if (failing > 0) parts.push(`${failing} failing`);
  if (approved > 0) parts.push(`${approved} approved`);
  return parts.join(' · ');
}

/**
 * What a worktree's own pull request merges into — the base a review must use.
 *
 * Only stacked work needs this. A layer's base is the layer below it, and that is
 * recorded nowhere else: the commit graph cannot supply it, because a layer cut
 * from its parent's *first* commit is not a descendant of the parent's tip and
 * neither branch contains the other. Reviewed against the trunk instead, a layer
 * is credited with every commit the layers beneath it added.
 *
 * Matched on the worktree as well as the branch, since a stack is several
 * worktrees of one repo and a task can hold several repos — the branch alone could
 * pick a namesake in the wrong one. Only a `head` pull request counts: the other
 * three discovery sources name branches this worktree is *not* on, whose bases say
 * nothing about what is checked out here.
 *
 * `undefined` covers every honest gap — no pull request yet, the search still out,
 * a base GitHub did not report — and the trunk is the right answer in all of them.
 */
export function baseFor(prs: TaskPr[] | undefined, repo: TaskRepo): string | undefined {
  if (!prs || !repo.branch) return undefined;
  return prs.find(
    (pr) => pr.via === 'head' && pr.branch === repo.branch && pr.repoName === repo.name,
  )?.base;
}

/**
 * Why a branch is believed to be the task's, in words.
 *
 * Every one of these is an inference of a different strength, and the card says
 * which — the same rule the fleet follows for a status nobody reported. A row
 * that turns out not to belong to the task is then a thing you can explain
 * rather than a thing you distrust.
 */
export const VIA_LABEL: Record<BranchVia, string> = {
  head: 'the branch this worktree is on',
  stack: "stacked on the task's branch",
  history: 'worked on in this worktree at some point',
  task: "the task's own branch",
};

/**
 * The repo each of a task's pull requests is on, keyed by `owner/name#number`.
 *
 * Only worth saying when the card holds pull requests from more than one repo,
 * which is the case this exists for: a task spanning two repos shows two rows
 * that otherwise differ only in a number, and "which one is the API change" is
 * then a tooltip away rather than in front of you. A stack is several pull
 * requests in *one* repo, so it gets no tags at all — the same word four times
 * says nothing, and `⇡` already explains how those rows relate.
 *
 * The bare name rather than `owner/name`: the owner is the same for every repo
 * you would be telling apart, so it is the half carrying no information.
 *
 * Keyed rather than returned per-row so both front ends can decide once, from
 * the whole list, whether the tags are worth showing.
 */
export function prRepoTags(prs: TaskPr[]): Record<string, string> {
  const tags: Record<string, string> = {};
  if (new Set(prs.map((pr) => pr.repo)).size < 2) return tags;
  for (const pr of prs) {
    tags[`${pr.repo}#${pr.number}`] = pr.repo.split('/').pop() ?? pr.repo;
  }
  return tags;
}

/** How loudly a card has to ask for you, worst state first. */
export type Severity = 'danger' | 'warn' | 'ok' | 'quiet';

/**
 * The one state a card is in, out of everything on it.
 *
 * The card already said all of this — `4 dirty` on one row, `changes requested`
 * on another, `approved` on a third — each in its own words, at the far right of
 * the row it belonged to. Which is fine once you are reading a card and useless
 * for finding out which card to read: five of them stacked up read as five
 * identical blocks. So this folds the lot into one rank, which the panel draws as
 * a stripe down the card's left edge, and the words stay where they were for once
 * you have arrived.
 *
 * The order is what you would do about it, not how bad it sounds. A blocked agent
 * is first because it is the only thing here that is *waiting* on you and getting
 * nothing done meanwhile. Failing checks and a rejected review come next: work
 * has come back. Uncommitted changes are yours to lose, so they outrank an
 * approval, which is merely a merge you have not got round to.
 *
 * `needsAttention` is a parameter because it is a fact about the session, not
 * about the task — no arrangement of repos and pull requests can tell you an
 * agent is stuck on a permission prompt.
 */
export function worstState(
  repos: TaskRepo[],
  prs: TaskPr[] | undefined,
  needsAttention: boolean,
): Severity {
  if (needsAttention) return 'danger';
  // `undefined` is the first `gh` search still being out, which is not the same
  // claim as "this task has no pull requests" — an absent answer contributes
  // nothing rather than confirming quiet.
  const open = prs ?? [];
  if (open.some((pr) => pr.reviewDecision === 'CHANGES_REQUESTED' || pr.checks === 'failing')) {
    return 'danger';
  }
  if (repos.some((r) => r.dirty > 0)) return 'warn';
  if (open.some((pr) => pr.reviewDecision === 'APPROVED')) return 'ok';
  return 'quiet';
}
