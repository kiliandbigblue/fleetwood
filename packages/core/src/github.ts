import { run } from './exec.ts';
import { loadConfig } from './config.ts';
import type { DeployPatterns, MergedConfig } from './config.ts';

export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';

export interface PullRequest {
  repo: string; // "bigbluedisco/atlas"
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  author?: string;
  /** Which list this PR came from; a PR can be in both. */
  roles: Array<'review-requested' | 'mine'>;
  // Enriched (a second call per PR):
  branch?: string;
  reviewDecision?: string;
  checks?: ChecksState;
  checksDetail?: { passing: number; failing: number; pending: number };
  additions?: number;
  deletions?: number;
}

interface SearchRow {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  repository?: { nameWithOwner?: string };
  author?: { login?: string };
}

const SEARCH_FIELDS = 'number,title,url,updatedAt,isDraft,repository,author';

/**
 * A search, keeping whether it actually ran.
 *
 * `ok` matters because an empty result is ambiguous: no open PRs assigned to you
 * and a broken `gh` look identical from the rows alone, and for merged PRs
 * "nothing merged in three days" is the ordinary case.
 */
async function searchRaw(flags: string[], limit: number): Promise<{ ok: boolean; rows: SearchRow[] }> {
  const config = await loadConfig();
  const args = ['search', 'prs', ...flags, `--limit=${limit}`, '--json', SEARCH_FIELDS];
  if (config.github.extraQualifiers.trim().length > 0) {
    args.push(...config.github.extraQualifiers.trim().split(/\s+/));
  }
  const { code, stdout } = await run('gh', args, { timeoutMs: 20_000 });
  if (code !== 0) return { ok: false, rows: [] };
  try {
    return { ok: true, rows: JSON.parse(stdout) as SearchRow[] };
  } catch {
    return { ok: false, rows: [] };
  }
}

async function search(flags: string[], limit: number): Promise<SearchRow[]> {
  return (await searchRaw(flags, limit)).rows;
}

function toPr(row: SearchRow, role: 'review-requested' | 'mine'): PullRequest | undefined {
  const repo = row.repository?.nameWithOwner;
  if (!repo) return undefined;
  return {
    repo,
    number: row.number,
    title: row.title,
    url: row.url,
    updatedAt: row.updatedAt,
    isDraft: row.isDraft,
    author: row.author?.login,
    roles: [role],
  };
}

interface CheckRun {
  status?: string;
  conclusion?: string;
  state?: string;
}

interface ViewResult {
  headRefName?: string;
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  statusCheckRollup?: CheckRun[];
}

export function summariseChecks(rollup: CheckRun[] | undefined): {
  state: ChecksState;
  detail: { passing: number; failing: number; pending: number };
} {
  const detail = { passing: 0, failing: 0, pending: 0 };
  if (!rollup || rollup.length === 0) return { state: 'none', detail };

  for (const check of rollup) {
    // GitHub reports check runs and legacy statuses differently: check runs use
    // status/conclusion, commit statuses use state.
    const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase();
    const status = (check.status ?? '').toUpperCase();
    if (status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING' || conclusion === 'PENDING') {
      detail.pending += 1;
    } else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
      detail.passing += 1;
    } else if (conclusion.length > 0) {
      detail.failing += 1;
    } else {
      detail.pending += 1;
    }
  }

  // Failing dominates: one red check is the thing you need to know.
  const state: ChecksState =
    detail.failing > 0 ? 'failing' : detail.pending > 0 ? 'pending' : detail.passing > 0 ? 'passing' : 'none';
  return { state, detail };
}

async function enrich(pr: PullRequest): Promise<PullRequest> {
  const { code, stdout } = await run(
    'gh',
    [
      'pr',
      'view',
      String(pr.number),
      '-R',
      pr.repo,
      '--json',
      'headRefName,reviewDecision,additions,deletions,statusCheckRollup',
    ],
    { timeoutMs: 20_000 },
  );
  if (code !== 0) return pr;
  try {
    const view = JSON.parse(stdout) as ViewResult;
    const checks = summariseChecks(view.statusCheckRollup);
    return {
      ...pr,
      branch: view.headRefName,
      reviewDecision: view.reviewDecision,
      additions: view.additions,
      deletions: view.deletions,
      checks: checks.state,
      checksDetail: checks.detail,
    };
  } catch {
    return pr;
  }
}

/** Bounded concurrency: `gh` spawns a process per call and we may have dozens. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface PrLists {
  reviewRequested: PullRequest[];
  mine: PullRequest[];
  fetchedAt: number;
  /** True when `gh` produced nothing at all — usually an auth or network problem. */
  degraded: boolean;
}

export async function fetchPrs(options: { limit?: number; enrich?: boolean } = {}): Promise<PrLists> {
  const limit = options.limit ?? 25;
  const [reviewRows, mineRows] = await Promise.all([
    search(['--review-requested=@me', '--state=open'], limit),
    search(['--author=@me', '--state=open'], limit),
  ]);

  const dedupe = new Map<string, PullRequest>();
  const add = (row: SearchRow, role: 'review-requested' | 'mine'): void => {
    const pr = toPr(row, role);
    if (!pr) return;
    const key = `${pr.repo}#${pr.number}`;
    const existing = dedupe.get(key);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else {
      dedupe.set(key, pr);
    }
  };
  for (const row of reviewRows) add(row, 'review-requested');
  for (const row of mineRows) add(row, 'mine');

  let all = [...dedupe.values()];
  if (options.enrich !== false) all = await mapLimit(all, 6, enrich);

  const byRecency = (a: PullRequest, b: PullRequest): number => b.updatedAt.localeCompare(a.updatedAt);

  return {
    reviewRequested: all.filter((p) => p.roles.includes('review-requested')).sort(byRecency),
    mine: all.filter((p) => p.roles.includes('mine')).sort(byRecency),
    fetchedAt: Math.floor(Date.now() / 1000),
    degraded: reviewRows.length === 0 && mineRows.length === 0,
  };
}

/**
 * Every open PR whose head branch is `branch`, across the whole org.
 *
 * This is what makes a task's pull requests findable as a set: the convention
 * reuses one branch name in every repo a change touches, so a single search
 * returns the lot — including PRs opened by a teammate or from another machine,
 * which no local bookkeeping could know about.
 */
export async function fetchPrsForBranch(branch: string, limit = 30): Promise<PullRequest[]> {
  const config = await loadConfig();
  const args = ['search', 'prs', `head:${branch}`, '--state=open', `--limit=${limit}`, '--json', SEARCH_FIELDS];
  if (config.github.extraQualifiers.trim().length > 0) {
    args.push(...config.github.extraQualifiers.trim().split(/\s+/));
  }
  const { code, stdout } = await run('gh', args, { timeoutMs: 20_000 });
  if (code !== 0) return [];
  try {
    const rows = JSON.parse(stdout) as SearchRow[];
    return rows
      .map((row) => toPr(row, 'mine'))
      .filter((pr): pr is PullRequest => pr !== undefined)
      .map((pr) => ({ ...pr, roles: [] as PullRequest['roles'] }));
  } catch {
    return [];
  }
}

/** Identifier stamped onto a tmux session so a PR maps to exactly one session. */
export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

// --- recently merged, and whether it still needs deploying ------------------

// The state machine lives in a leaf module so the renderer can import it without
// dragging `node:child_process` into the bundle. Re-exported here so `github.*`
// stays the one place callers look.
export {
  byUrgencyThenRecency,
  classifyRun,
  isDone,
  isSettled,
  isTerminal,
  needsDeploy,
  patternsFor,
  summariseDeploy,
} from './deployState.ts';
export type { DeployRollup, DeployState, RunRole, WorkflowRun } from './deployState.ts';

import {
  byUrgencyThenRecency,
  classifyRun,
  isSettled,
  isTerminal,
  patternsFor,
  summariseDeploy,
} from './deployState.ts';
import type { DeployRollup, WorkflowRun } from './deployState.ts';

interface RunRow {
  workflowName?: string;
  status?: string;
  conclusion?: string;
  headBranch?: string;
  url?: string;
}

/**
 * Every workflow run attached to a commit, branch- and tag-triggered alike.
 *
 * This is the call the whole feature rests on. A tag-triggered image build still
 * carries the merge commit as its head SHA — the tag points at it — so one query
 * sees the entire test → autotag → build chain, and hands back the tag name with
 * it. Querying the branch ref would miss the build entirely.
 */
export async function fetchWorkflowRuns(
  repo: string,
  sha: string,
  patterns: DeployPatterns,
): Promise<WorkflowRun[]> {
  const { code, stdout } = await run(
    'gh',
    [
      'run',
      'list',
      '-R',
      repo,
      '--commit',
      sha,
      '--limit',
      '50',
      '--json',
      'workflowName,status,conclusion,headBranch,url',
    ],
    { timeoutMs: 20_000 },
  );
  if (code !== 0) return [];
  try {
    const rows = JSON.parse(stdout) as RunRow[];
    return rows.map((row) => {
      const name = row.workflowName ?? '';
      return {
        name,
        role: classifyRun(name, patterns),
        status: row.status ?? '',
        conclusion: row.conclusion ?? '',
        headBranch: row.headBranch ?? '',
        url: row.url ?? '',
      };
    });
  } catch {
    return [];
  }
}

export interface MergedPr extends PullRequest {
  mergedAt: string;
  mergeCommit?: string;
  baseRefName?: string;
  /** False when someone else opened it — you merged or reviewed it. */
  mine: boolean;
  deploy: DeployRollup;
  /**
   * When you marked it deployed yourself, in epoch seconds.
   *
   * For the Go services CI stops at a pushed image, so this is the only place
   * "it is live" can come from.
   */
  deployedByHand?: number;
}


export interface MergedPrs {
  prs: MergedPr[];
  fetchedAt: number;
  /** True when `gh` produced nothing at all — usually auth or network. */
  degraded: boolean;
}

interface MergedViewResult {
  mergedAt?: string;
  mergeCommit?: { oid?: string };
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  author?: { login?: string };
}

let cachedLogin: string | undefined;

/** Your login, for telling your own merges from ones you merged for someone. */
export async function currentLogin(): Promise<string | undefined> {
  if (cachedLogin !== undefined) return cachedLogin;
  const { code, stdout } = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 });
  if (code !== 0) return undefined;
  const login = stdout.trim();
  if (login.length === 0) return undefined;
  cachedLogin = login;
  return login;
}

export interface FetchMergedOptions {
  config: MergedConfig;
  limit?: number;
  /** Already-terminal PRs by `prKey`, to skip the per-PR fan-out entirely. */
  cached?: Map<string, MergedPr>;
  /** `prKey → epoch seconds` for merges you deployed by hand. */
  marks?: Map<string, number>;
  now?: number;
}

/**
 * PRs merged inside the lookback window that you opened or had a hand in.
 *
 * `--involves=@me` rather than `--author=@me`: it is a superset, and it catches a
 * teammate's PR you reviewed and merged — which you would be the one to deploy.
 * GitHub search has no `merged-by:` qualifier, so this is as close as it gets.
 */
export async function fetchMergedPrs(options: FetchMergedOptions): Promise<MergedPrs> {
  const { config } = options;
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 25;
  const cached = options.cached ?? new Map<string, MergedPr>();
  const cutoff = now - config.lookbackHours * 3_600_000;
  // Date granularity, deliberately generous: the exact cut is applied below
  // against the real `mergedAt`, which the search API cannot return.
  const since = new Date(cutoff - 86_400_000).toISOString().slice(0, 10);

  const [found, login] = await Promise.all([
    searchRaw(['--involves=@me', '--merged', `--merged-at=>=${since}`], limit),
    currentLogin(),
  ]);
  // An empty list is the good outcome, so only a failed call is degraded.
  if (!found.ok) {
    return { prs: [], fetchedAt: Math.floor(now / 1000), degraded: true };
  }

  const enriched = await mapLimit(found.rows, 6, async (row): Promise<MergedPr | undefined> => {
    const base = toPr(row, 'mine');
    if (!base) return undefined;
    const key = prKey(base.repo, base.number);

    const hit = cached.get(key);
    if (hit && isTerminal(hit.deploy.state)) {
      // The cut is applied here too: the search's date filter is deliberately a
      // day looser than the window, so a cached row would otherwise linger past it.
      return Date.parse(hit.mergedAt) >= cutoff ? hit : undefined;
    }

    const view = await run(
      'gh',
      [
        'pr',
        'view',
        String(base.number),
        '-R',
        base.repo,
        '--json',
        'mergedAt,mergeCommit,baseRefName,headRefName,additions,deletions,author',
      ],
      { timeoutMs: 20_000 },
    );
    if (view.code !== 0) return undefined;

    let detail: MergedViewResult;
    try {
      detail = JSON.parse(view.stdout) as MergedViewResult;
    } catch {
      return undefined;
    }
    const mergedAt = detail.mergedAt ?? '';
    if (mergedAt.length === 0 || Date.parse(mergedAt) < cutoff) return undefined;

    const sha = detail.mergeCommit?.oid;
    const patterns = patternsFor(base.repo, config);
    const runs = sha ? await fetchWorkflowRuns(base.repo, sha, patterns) : [];
    const author = detail.author?.login ?? base.author;

    return {
      ...base,
      roles: [],
      author,
      branch: detail.headRefName,
      additions: detail.additions,
      deletions: detail.deletions,
      mergedAt,
      mergeCommit: sha,
      baseRefName: detail.baseRefName,
      mine: login !== undefined && author === login,
      deploy: summariseDeploy(runs, {
        settled: isSettled(mergedAt, config.settleMinutes, now),
      }),
    };
  });

  const marks = options.marks ?? new Map<string, number>();
  const prs = enriched
    .filter((pr): pr is MergedPr => pr !== undefined)
    // Marks are applied after the cache, so marking one costs no `gh` calls and
    // a cached row cannot carry a stale mark.
    .map((pr) => {
      const at = marks.get(prKey(pr.repo, pr.number));
      return at === undefined ? pr : { ...pr, deployedByHand: at };
    })
    // What is still owed floats to the top; finished work sinks but stays
    // readable, because confirming it is the moment you post to Slack.
    .sort(byUrgencyThenRecency);

  return { prs, fetchedAt: Math.floor(now / 1000), degraded: false };
}
