import type { FleetAgent } from './fleet.ts';
import type { Task, TaskRepo } from './task.ts';

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
  // A repo whose branch we could not read is not evidence of drift — only a branch
  // we read and which differs is.
  const off = repos.filter((r) => r.branch && r.branch !== taskBranch).length;
  const parts = [`${repos.length} repo${repos.length === 1 ? '' : 's'}`];
  if (dirty > 0) parts.push(`${dirty} dirty`);
  if (off > 0) parts.push(`${off} off-branch`);
  return parts.join(' · ');
}
