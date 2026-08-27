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
