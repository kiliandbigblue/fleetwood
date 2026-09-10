import { run } from './exec.ts';
import {
  enrichPr,
  fetchPrsForBranches,
  fetchPrsForRepoBranches,
  mapLimit,
  prKey,
} from './github.ts';
import { localDefaultBranch, remoteNameWithOwner } from './worktree.ts';
import type { PullRequest, RepoBranch } from './github.ts';
import type { Task } from './task.ts';

/*
 * The pull requests a task has open, found from the worktrees themselves.
 *
 * A task is a folder of worktrees and nothing records what it has pushed, so the
 * link back to GitHub has to be rebuilt from git. The naive read — "the branch
 * each worktree is on" — misses the case this exists for: stacked work, where
 * one change becomes four branches and four pull requests, and only the tip is
 * checked out anywhere. So four sources are used per worktree, and the widest of
 * them is not a guess: a stack *is* a chain of branches each containing the one
 * below, which `git branch --contains` answers exactly.
 */

/** How a branch was found to belong to a task. Ordered by how strongly it claims it. */
export type BranchVia = 'head' | 'stack' | 'history' | 'task';

export interface TaskBranch {
  branch: string;
  /** The task folder's subdirectory it was found in; absent for the task's own branch. */
  repoName?: string;
  /** `owner/name`, read from the worktree's origin remote. Absent when git wouldn't say. */
  repo?: string;
  via: BranchVia;
  /** Commits it holds that the repo's default branch has not — also its rung in a stack. */
  ahead?: number;
}

/** One task's branches, as `matchPrsToTasks` wants them. */
export interface TaskBranches {
  slug: string;
  branches: TaskBranch[];
}

/** An open pull request, plus which of the task's branches it was opened from. */
export interface TaskPr extends PullRequest {
  branch: string;
  via: BranchVia;
  repoName?: string;
  ahead?: number;
}

export interface TaskPrs {
  /** slug → its open pull requests, bottom of the stack first. */
  byTask: Record<string, TaskPr[]>;
  fetchedAt: number;
  /** True when `gh` produced nothing at all — usually an auth or network problem. */
  degraded: boolean;
}

/**
 * Branch names out of a worktree's own HEAD reflog.
 *
 * Git keeps this log per worktree, which is the only reason it can answer "what
 * was worked on *here*" rather than "in this repo". Both sides of a checkout are
 * taken — the branch left behind was worked on here just as much as the one
 * arrived at. A detached checkout names a commit rather than a branch; those are
 * dropped instead of being searched for as head refs.
 */
export function parseCheckoutBranches(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
    if (!match) continue;
    for (const name of [match[1], match[2]]) {
      if (name === undefined || /^[0-9a-f]{7,40}$/.test(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Parse `%(refname:short) %(ahead-behind:<base>)` — one line per local branch. */
export function parseAheadBehind(stdout: string): Map<string, { ahead: number; behind: number }> {
  const out = new Map<string, { ahead: number; behind: number }>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [branch, ahead, behind] = parts;
    const a = Number.parseInt(ahead as string, 10);
    const b = Number.parseInt(behind as string, 10);
    if (branch === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.set(branch, { ahead: a, behind: b });
  }
  return out;
}

/**
 * Bare trunk name for comparing against local branch names.
 *
 * `localDefaultBranch` returns the remote-tracking ref (`origin/main`) on purpose —
 * a task worktree often has no local copy of the trunk. Candidates from
 * `git branch` and the reflog are bare (`main`), so a straight `===` against
 * `origin/main` lets the trunk through. Searching `head:main` org-wide then
 * returns hundreds of unrelated pull requests and starves every other branch in
 * the batch.
 */
export function trunkBranchName(defaultBranchRef: string | undefined): string | undefined {
  if (!defaultBranchRef) return undefined;
  return defaultBranchRef.startsWith('origin/')
    ? defaultBranchRef.slice('origin/'.length)
    : defaultBranchRef;
}

/**
 * Every branch a task might have a pull request on, across all its worktrees.
 *
 * Four sources, listed in the order of how strongly each claims the branch is
 * the task's:
 *
 * - **head** — the branch a worktree is checked out on. The obvious one.
 * - **stack** — branches containing the task's branch. This is what makes stacked
 *   work visible: each layer of a stack builds on the one below, so containment
 *   is the definition rather than a heuristic. Only asked when the task's branch
 *   has commits of its own, because a branch still level with `dev` is contained
 *   by every branch in the repo.
 * - **history** — branches checked out in that worktree at some point, from its
 *   own reflog. Catches the side branch cut straight from `dev` in the same
 *   directory, which containment cannot see.
 * - **task** — the task's own branch, whether or not any worktree is on it. The
 *   only entry allowed to match a repo the task folder does not hold: the naming
 *   convention reuses one branch across every repo a change touches, so a
 *   teammate's pull request in a repo nobody has added yet is still this task's.
 *
 * Everything except the last is narrowed to branches holding commits the repo's
 * default branch has not. That is what drops `dev`, `main` and every spent branch
 * the reflog remembers, and it comes free: the same read gives each branch's
 * distance from the default, which is also its rung in a stack.
 */
export async function discoverTaskBranches(task: Task): Promise<TaskBranches> {
  const branches: TaskBranch[] = [];
  const seen = new Set<string>();
  const add = (entry: TaskBranch): void => {
    const key = `${entry.repoName ?? ''} ${entry.branch}`;
    if (seen.has(key)) return;
    seen.add(key);
    branches.push(entry);
  };

  for (const repo of task.repos) {
    const [defaultBranch, owner] = await Promise.all([
      localDefaultBranch(repo.path),
      // `repo.repo` usually holds this already, but not always — and a wrong
      // owner here would file another repo's namesake branch under this task.
      repo.repo ? Promise.resolve(repo.repo) : remoteNameWithOwner(repo.path),
    ]);
    const trunk = trunkBranchName(defaultBranch);

    // One read doing both jobs: which branches hold work of their own, and how much.
    const distance = defaultBranch
      ? parseAheadBehind(
          (
            await run('git', [
              '-C',
              repo.path,
              'for-each-ref',
              '--format',
              `%(refname:short) %(ahead-behind:${defaultBranch})`,
              'refs/heads',
            ])
          ).stdout,
        )
      : new Map<string, { ahead: number; behind: number }>();

    // No default branch to compare against: keep the branch and say nothing about
    // its rung. Silence is the honest answer there, not exclusion.
    const hasOwnWork = (branch: string): boolean =>
      !defaultBranch || (distance.get(branch)?.ahead ?? 0) > 0;

    const candidates: Array<{ branch: string; via: BranchVia }> = [];
    if (repo.branch) candidates.push({ branch: repo.branch, via: 'head' });

    if (distance.has(task.branch) && hasOwnWork(task.branch)) {
      const stack = await run('git', [
        '-C',
        repo.path,
        'branch',
        '--contains',
        task.branch,
        '--format=%(refname:short)',
      ]);
      if (stack.code === 0) {
        for (const name of stack.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)) {
          candidates.push({ branch: name, via: 'stack' });
        }
      }
    }

    const reflog = await run('git', [
      '-C',
      repo.path,
      'reflog',
      'show',
      '-n',
      '200',
      '--format=%gs',
      'HEAD',
    ]);
    if (reflog.code === 0) {
      for (const name of parseCheckoutBranches(reflog.stdout)) {
        candidates.push({ branch: name, via: 'history' });
      }
    }

    for (const candidate of candidates) {
      // Bare name, not `origin/main` — see `trunkBranchName`.
      if (trunk && candidate.branch === trunk) continue;
      if (!hasOwnWork(candidate.branch)) continue;
      add({
        ...candidate,
        repoName: repo.name,
        repo: owner,
        ahead: distance.get(candidate.branch)?.ahead,
      });
    }
  }

  add({ branch: task.branch, via: 'task' });
  return { slug: task.slug, branches };
}

/** Which entry describes a pull request when several of a task's branches match it. */
const VIA_RANK: Record<BranchVia, number> = { head: 0, stack: 1, history: 2, task: 3 };

function betterEntry(a: TaskBranch, b: TaskBranch): TaskBranch {
  // A branch found in a worktree says where the work is; the task-level entry
  // only says the name matched.
  const named = Number(b.repoName !== undefined) - Number(a.repoName !== undefined);
  if (named !== 0) return named < 0 ? a : b;
  return VIA_RANK[a.via] <= VIA_RANK[b.via] ? a : b;
}

/**
 * File each pull request under the tasks whose branches it was opened from.
 *
 * Pure, and kept apart from the fetching because this is where the judgement is:
 * a `head:` search is org-wide, so a branch name that exists in two repos comes
 * back twice. A pull request counts for a task when it is in a repo the task
 * actually holds — or when it is on the task's own branch, which is the one name
 * the convention deliberately reuses across repos.
 */
export function matchPrsToTasks(
  sets: TaskBranches[],
  prs: PullRequest[],
  owners: string[] = [],
): Record<string, TaskPr[]> {
  const byTask: Record<string, TaskPr[]> = {};
  const allowed = new Set(owners);
  // The task entry is the one that may match a repo the folder does not hold,
  // and that licence is what a bare branch name abuses: `feature/new-app` is a
  // name strangers use too, and an org-wide search returns theirs. Requiring
  // the owner to be one the fleet works in keeps the case this is for — a
  // teammate's pull request in a repo nobody has cloned — and drops the rest.
  // An empty allowlist means nothing could be read from git, so nothing is
  // narrowed: silence must not be read as "no owner is legitimate".
  const ownerAllowed = (repo: string): boolean => {
    if (allowed.size === 0) return true;
    const slash = repo.indexOf('/');
    return allowed.has(slash > 0 ? repo.slice(0, slash) : repo);
  };

  for (const set of sets) {
    const picked = new Map<string, TaskPr>();
    for (const pr of prs) {
      const branch = pr.branch;
      if (branch === undefined) continue;
      const matches = set.branches.filter(
        (entry) =>
          entry.branch === branch &&
          (entry.via === 'task'
            ? ownerAllowed(pr.repo)
            : entry.repo === undefined || entry.repo === pr.repo),
      );
      if (matches.length === 0) continue;

      const entry = matches.reduce(betterEntry);
      const key = prKey(pr.repo, pr.number);
      const existing = picked.get(key);
      if (existing && VIA_RANK[existing.via] <= VIA_RANK[entry.via]) continue;
      picked.set(key, { ...pr, branch, via: entry.via, repoName: entry.repoName, ahead: entry.ahead });
    }

    if (picked.size === 0) continue;
    // Bottom of the stack first: distance from the default branch is what orders
    // a stack, since each layer holds every commit below it and then some. A
    // branch whose distance could not be read sinks, in pull request order.
    byTask[set.slug] = [...picked.values()].sort(
      (a, b) =>
        (a.ahead ?? Number.MAX_SAFE_INTEGER) - (b.ahead ?? Number.MAX_SAFE_INTEGER) ||
        a.number - b.number,
    );
  }
  return byTask;
}

/** Cache key for an enriched pull request: enrichment is stale only once it moves. */
export function prCacheKey(pr: PullRequest): string {
  return `${prKey(pr.repo, pr.number)}@${pr.updatedAt}`;
}

export interface FetchTaskPrsOptions {
  tasks: Task[];
  /** Last poll's enriched pull requests, by `prCacheKey`. Rebuilt by the caller. */
  cached?: Map<string, PullRequest>;
  now?: number;
  /**
   * Also search org-wide for the branches whose repo is unknown.
   *
   * Off by default, and meant for a slower clock than the poll. It is the only
   * part of this that still touches the search API, and the case it covers —
   * a teammate opening a pull request on the task's branch in a repo nobody
   * has added to the task folder — is both rare and not urgent. Everything a
   * worktree can name its remote for is answered by the lookup instead.
   */
  searchUnclonedRepos?: boolean;
}

export interface TaskPrsResult extends TaskPrs {
  /** Every enriched pull request seen this round, for the caller's cache. */
  enriched: PullRequest[];
  /**
   * Whether `byTask` is an answer at all.
   *
   * Distinct from `degraded`, and the distinction is the point. `ok: false` is
   * the lookup itself failing, where the only honest move is to keep whatever
   * was on screen before. `degraded` is softer: the lookup answered, and only
   * the org-wide fallback for uncloned repos did not, so `byTask` is complete
   * for every branch a worktree could name and possibly missing one nobody has
   * cloned. Collapsing the two would throw a good answer away for a gap in the
   * rarest corner of it.
   */
  ok: boolean;
}

/**
 * The repository owners the fleet works in, from the remotes git could name.
 *
 * The bound on the org-wide fallback, and deliberately fleet-wide rather than
 * per-task: a task whose every worktree is a local-only repo knows no owner of
 * its own, and would otherwise be the one task left unbounded.
 */
export function fleetOwners(sets: TaskBranches[]): string[] {
  const owners = new Set<string>();
  for (const set of sets) {
    for (const entry of set.branches) {
      if (entry.repo === undefined) continue;
      const slash = entry.repo.indexOf('/');
      if (slash > 0) owners.add(entry.repo.slice(0, slash));
    }
  }
  return [...owners];
}

/**
 * Every branch of a task whose repo is known, as a lookup rather than a search.
 *
 * Deduped across tasks: the naming convention reuses one branch name in every
 * repo a change touches, and two tasks stacked in the same repo share their
 * lower layers, so the same pair turns up more than once and is worth asking
 * about once.
 */
export function repoBranchPairs(sets: TaskBranches[]): RepoBranch[] {
  const pairs = new Map<string, RepoBranch>();
  for (const set of sets) {
    for (const entry of set.branches) {
      if (entry.repo === undefined) continue;
      pairs.set(`${entry.repo} ${entry.branch}`, { repo: entry.repo, branch: entry.branch });
    }
  }
  return [...pairs.values()];
}

/**
 * The branch names left over: real branches whose repo git would not name.
 *
 * Two kinds reach here. The task's own entry, which is deliberately repo-less
 * so it can match a pull request in a repo the task folder does not hold; and
 * a worktree whose origin remote could not be read at all. Both can only be
 * answered by an org-wide search, which is why they are separated out rather
 * than folded in — that search is the expensive half, and the half that gets
 * refused.
 */
export function unclonedBranchNames(sets: TaskBranches[]): string[] {
  const named = new Set<string>();
  const orphans = new Set<string>();
  for (const set of sets) {
    for (const entry of set.branches) {
      if (entry.repo === undefined) orphans.add(entry.branch);
      else named.add(entry.branch);
    }
  }
  // A name we already looked up in a real repo does not need searching for;
  // only a name no worktree could place is worth the org-wide query.
  for (const name of named) orphans.delete(name);
  return [...orphans];
}

/**
 * The open pull requests of every task, in as few `gh` calls as it can be done in.
 *
 * One GraphQL request for the whole fleet. A task's worktree names its own
 * origin remote, so for all but the branch nobody has cloned the repo and the
 * ref are both already known — which makes this a lookup, and a lookup is not
 * only cheaper than the `head:` search it replaces but on a different budget.
 * The search endpoint has a secondary throttle that refuses a burst of scatter
 * queries while every published allowance still reads untouched, and stays
 * refusing for minutes; asking `repository(owner:, name:)` about a ref it can
 * find directly never goes near it.
 *
 * It also removes the second call per pull request. A search cannot return a
 * head ref, so each hit used to cost a `gh pr view` for its branch, base,
 * reviews and checks; those all arrive inline here, and the cache that existed
 * to blunt that fan-out is no longer on the critical path — it is kept only for
 * the org-wide fallback, which still enriches the old way.
 */
export async function fetchTaskPrs(options: FetchTaskPrsOptions): Promise<TaskPrsResult> {
  const now = options.now ?? Date.now();
  const cached = options.cached ?? new Map<string, PullRequest>();
  const empty = { byTask: {}, fetchedAt: Math.floor(now / 1000), enriched: [], ok: true };

  const sets = await mapLimit(options.tasks, 4, discoverTaskBranches);
  const pairs = repoBranchPairs(sets);
  const uncloned = options.searchUnclonedRepos ? unclonedBranchNames(sets) : [];
  if (pairs.length === 0 && uncloned.length === 0) return { ...empty, degraded: false };

  const owners = fleetOwners(sets);
  const [found, searched] = await Promise.all([
    fetchPrsForRepoBranches(pairs),
    uncloned.length > 0
      ? fetchPrsForBranches(uncloned, 200, owners)
      : Promise.resolve({ ok: true, prs: [] }),
  ]);
  // The lookup failing is a broken answer; the org-wide fallback failing is the
  // rate limit doing what it does, and must not blank pull requests the lookup
  // just returned perfectly well.
  if (!found.ok) return { ...empty, ok: false, degraded: true };

  const extra = searched.ok
    ? await mapLimit(searched.prs, 4, async (pr) => cached.get(prCacheKey(pr)) ?? enrichPr(pr))
    : [];

  // The lookup wins a collision: it named the repo and the ref it asked about,
  // where the search only matched a name.
  const byKey = new Map<string, PullRequest>();
  for (const pr of extra) byKey.set(prKey(pr.repo, pr.number), pr);
  for (const pr of found.prs) byKey.set(prKey(pr.repo, pr.number), pr);
  const enriched = [...byKey.values()];

  return {
    byTask: matchPrsToTasks(sets, enriched, owners),
    fetchedAt: Math.floor(now / 1000),
    degraded: !searched.ok,
    enriched,
    ok: true,
  };
}
