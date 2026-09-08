import { hasDriftedOffBranch } from './naming.ts';
import type { FleetAgent } from './fleet.ts';
import type { PullRequest } from './github.ts';
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
 *
 * The shape comes last, after both of those: a stack asks nothing of you, it only
 * says that `4 open` is four rungs rather than four errands.
 */
export function prSummary(prs: TaskPr[]): string {
  const failing = prs.filter((pr) => pr.checks === 'failing').length;
  const approved = prs.filter((pr) => pr.reviewDecision === 'APPROVED').length;
  const stacks = stackSizes(prs);
  const parts = [`${prs.length} open`];
  if (failing > 0) parts.push(`${failing} failing`);
  if (approved > 0) parts.push(`${approved} approved`);
  if (stacks.length > 0) {
    parts.push(`stack${stacks.length === 1 ? '' : 's'} of ${stacks.join(', ')}`);
  }
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
 * says nothing, and the rung column from `groupPrStacks` already says how those
 * rows relate.
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
 * a mark beside the title, and the words stay where they were for once you have
 * arrived.
 *
 * The order is what you would do about it, not how bad it sounds. A blocked agent
 * is first because it is the only thing here that is *waiting* on you and getting
 * nothing done meanwhile. Failing checks and a rejected review come next: work
 * has come back. Uncommitted changes are yours to lose, so they outrank an
 * approval or a live agent, which are merely things still moving.
 *
 * A working (or compacting) agent is `ok` for the same reason an approval is:
 * something is happening that is not asking you for anything. Without that rung,
 * a card with a live cursor sat at `quiet` — the same mark as a dormant folder —
 * while its agent row alone carried the accent. The title mark has to agree.
 *
 * `needsAttention` is a parameter because it is a fact about the session, not
 * about the task — no arrangement of repos and pull requests can tell you an
 * agent is stuck on a permission prompt. Agents are optional for the same
 * reason: a caller that has none (or has not looked) must not invent quiet by
 * passing an empty list when the honest answer is "I did not check".
 */
export function worstState(
  repos: TaskRepo[],
  prs: TaskPr[] | undefined,
  needsAttention: boolean,
  agents?: ReadonlyArray<{ status: string }>,
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
  if (agents?.some((a) => a.status === 'working' || a.status === 'compacting')) return 'ok';
  return 'quiet';
}
/**
 * Branch names a pull request may merge into without that meaning "stacked".
 *
 * Only ever consulted as a veto, and only in one situation: a trunk is nobody's
 * head branch, so it never appears in the index below and normally cannot start
 * a chain at all. The exception is the release pull request — `dev` open against
 * `main` — which *is* a pull request whose head is a trunk, and which would
 * otherwise adopt every branch cut from `dev` as a layer sitting on it.
 */
const TRUNK_NAMES = new Set([
  'main',
  'master',
  'dev',
  'develop',
  'trunk',
  'production',
  'staging',
  'release',
]);

/** How far a parent walk goes before it is treated as a cycle. */
const WALK_CAP = 32;

/** The fields the stack grouper reads. `ahead` is present on a `TaskPr` only. */
type Stackable = PullRequest & { ahead?: number };

/** One pull request, and where it sits in the stack it belongs to. */
export interface StackRow<T> {
  pr: T;
  /** Distance from the bottom of its stack. 0 for a standalone or a bottom layer. */
  depth: number;
  /**
   * 1-based position in its stack's printed order.
   *
   * Position, not graph depth — the two coincide for a line, which is the shape a
   * stack actually takes, and differ only when two layers share one base.
   */
  rung: number;
  /** How many pull requests the stack holds — 1 when it is not one. */
  of: number;
  /** The still-open pull request this one merges into, when it is in view. */
  waitingOn?: number;
}

const prId = (pr: Stackable): string => `${pr.repo}#${pr.number}`;
const headKey = (repo: string, branch: string): string => `${repo} ${branch}`;

/** A stack is ordered bottom first — the same tie-break `matchPrsToTasks` uses. */
const byRung = (a: Stackable, b: Stackable): number =>
  (a.ahead ?? Number.MAX_SAFE_INTEGER) - (b.ahead ?? Number.MAX_SAFE_INTEGER) || a.number - b.number;

/**
 * Pull requests in render order, each told which stack it is in and where.
 *
 * A layer's parent is recorded in exactly one place — its base branch. The commit
 * graph cannot supply it, because a layer cut from its parent's *first* commit is
 * not a descendant of the parent's tip and neither branch contains the other; see
 * `PullRequest.base` in `github.ts`. So the whole of the linking is one rule: a
 * pull request sits on another when its base is that one's head branch, in the
 * same repo.
 *
 * That rule needs no notion of what the trunk is. `dev` and `main` are nobody's
 * head branch, so a pull request based on one links to nothing and stands alone —
 * no default-branch field, and no git call from a module the renderer imports.
 *
 * Flat rather than nested, and the same length as the input: every call site
 * renders the list it already rendered, one prop richer. Nesting would also have
 * to lie about a partial view — the PR tab splits one stack across two sections —
 * whereas `rung` and `of`, counted over `known`, stay honest under any filter.
 *
 * `waitingOn` is a pull request that is *open*, and that is sound rather than
 * checked: every list this runs on is built from an `--state=open` search, so a
 * layer whose parent has merged finds no parent and becomes a bottom layer.
 *
 * @param prs   the list to render, in the order it should render in.
 * @param known every pull request in view, when `prs` is a filtered part of one —
 *              what `rung`, `of` and `waitingOn` are counted against.
 */
export function groupPrStacks<T extends Stackable>(
  prs: T[],
  known?: Stackable[],
): Array<StackRow<T>> {
  const universe: Stackable[] = known ?? prs;

  // Which pull request each branch is the head of. Repo-scoped, so a namesake
  // branch in another repo cannot be adopted as a layer.
  const heads = new Map<string, Stackable>();
  for (const pr of universe) {
    if (pr.branch === undefined) continue;
    const key = headKey(pr.repo, pr.branch);
    const existing = heads.get(key);
    // Two open pull requests from one branch should not happen; pick one anyway.
    if (!existing || pr.number < existing.number) heads.set(key, pr);
  }

  const parentOf = (pr: Stackable): Stackable | undefined => {
    if (pr.base === undefined || pr.base === pr.branch || TRUNK_NAMES.has(pr.base)) return undefined;
    const parent = heads.get(headKey(pr.repo, pr.base));
    if (!parent || prId(parent) === prId(pr)) return undefined;
    // A layer holds every commit below it and then some, so one no further from
    // the trunk than its base is not sitting on it, whatever the base says.
    // Insurance rather than mechanism: `ahead` is a task's field, absent in the PR tab.
    if (parent.ahead !== undefined && pr.ahead !== undefined && parent.ahead >= pr.ahead) {
      return undefined;
    }
    return parent;
  };

  const parent = new Map<string, Stackable>();
  for (const pr of universe) {
    const found = parentOf(pr);
    if (found) parent.set(prId(pr), found);
  }

  // GitHub cannot serve a cycle, but a stale cache plus a retargeted base could.
  // The edge that closes the loop is cut, which makes that layer a bottom one.
  for (const pr of universe) {
    const seen = new Set([prId(pr)]);
    let cursor = pr;
    for (let hops = 0; hops < WALK_CAP; hops++) {
      const next = parent.get(prId(cursor));
      if (!next) break;
      if (seen.has(prId(next))) {
        parent.delete(prId(cursor));
        break;
      }
      seen.add(prId(next));
      cursor = next;
    }
  }

  const children = new Map<string, Stackable[]>();
  const roots: Stackable[] = [];
  for (const pr of universe) {
    const below = parent.get(prId(pr));
    if (!below) {
      roots.push(pr);
      continue;
    }
    const list = children.get(prId(below));
    if (list) list.push(pr);
    else children.set(prId(below), [pr]);
  }

  // Each stack in printed order, bottom first, with every layer's depth.
  const componentOf = new Map<string, string>();
  const order = new Map<string, Stackable[]>();
  const depths = new Map<string, number>();
  for (const root of roots) {
    const members: Stackable[] = [];
    const walk = (node: Stackable, depth: number): void => {
      members.push(node);
      depths.set(prId(node), depth);
      componentOf.set(prId(node), prId(root));
      for (const kid of [...(children.get(prId(node)) ?? [])].sort(byRung)) walk(kid, depth + 1);
    };
    walk(root, 0);
    order.set(prId(root), members);
  }

  // A stack is emitted where its earliest member sat — the bottom layer in a task
  // card, whose list is already bottom-first, and the most recently updated one in
  // the PR tab, so a stack keeps its recency slot rather than being hoisted out of it.
  const mine = new Map(prs.map((pr) => [prId(pr), pr]));
  const rows: Array<StackRow<T>> = [];
  const emitted = new Set<string>();
  for (const pr of prs) {
    if (emitted.has(prId(pr))) continue;
    const root = componentOf.get(prId(pr));
    const members = root === undefined ? undefined : order.get(root);
    if (!members) {
      // Only reachable when `known` omits something `prs` holds. Standing alone is
      // the honest answer: nothing was said about what this one sits on.
      emitted.add(prId(pr));
      rows.push({ pr, depth: 0, rung: 1, of: 1 });
      continue;
    }
    let rung = 0;
    for (const member of members) {
      // Counted over the whole stack, so a filtered view still says `2 of 3`.
      rung += 1;
      const own = mine.get(prId(member));
      if (!own || emitted.has(prId(member))) continue;
      emitted.add(prId(member));
      rows.push({
        pr: own,
        depth: depths.get(prId(member)) ?? 0,
        rung,
        of: members.length,
        waitingOn: parent.get(prId(member))?.number,
      });
    }
  }
  return rows;
}

/**
 * The size of each stack in a list, largest first — nothing at all for a list with none.
 *
 * A stack of one is not a stack, so only the components holding two or more count.
 */
export function stackSizes(prs: Stackable[]): number[] {
  return groupPrStacks(prs)
    .filter((row) => row.rung === 1 && row.of > 1)
    .map((row) => row.of)
    .sort((a, b) => b - a);
}
