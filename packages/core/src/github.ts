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
  /**
   * The branch this pull request merges into.
   *
   * For most it is the trunk and says nothing new. For a stacked pull request it
   * is the layer below, which is the one place that fact is recorded anywhere:
   * the commit graph cannot supply it, since a layer cut from its parent's first
   * commit is not a descendant of the parent's tip, and neither branch contains
   * the other.
   */
  base?: string;
  /** Normalised by `effectiveReviewDecision` — not raw `gh` output. */
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
  /** Check runs are named; legacy commit statuses carry a `context` instead. */
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /** Both shapes carry it, and it is what tells one attempt from its retry. */
  startedAt?: string;
  completedAt?: string;
}

/**
 * Compile the ignore pattern once per rollup, or not at all.
 *
 * `undefined` for an empty *or* an unparseable pattern: a typo in the config
 * must not silently hide every check and report a broken PR as green.
 */
function ignoreMatcher(pattern: string): RegExp | undefined {
  if (pattern.trim().length === 0) return undefined;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

interface ViewResult {
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
  latestReviews?: Array<{ state?: string }>;
  additions?: number;
  deletions?: number;
  statusCheckRollup?: CheckRun[];
}

/**
 * The review state as the pull request actually stands, not as GitHub reports it.
 *
 * `reviewDecision` is sticky: re-request a review from the person who asked for
 * changes and it stays `CHANGES_REQUESTED` until they submit again, so a pull
 * request that is waiting on a reviewer reads as one waiting on the author —
 * exactly backwards for a board whose whole job is showing what you owe.
 *
 * `latestReviews` is the field that does move. GitHub drops a reviewer from it
 * the moment their review is re-requested, because that review is no longer
 * current, so a `CHANGES_REQUESTED` decision with nothing blocking in
 * `latestReviews` is precisely the re-requested case, and becomes
 * `REVIEW_REQUIRED` here. Every other decision is passed through untouched:
 * `APPROVED` is not weakened by a re-request, and an absent decision stays
 * absent rather than being invented.
 *
 * Pure, and exported for its test.
 */
export function effectiveReviewDecision(
  decision: string | undefined,
  latestReviews: Array<{ state?: string }> | undefined,
): string | undefined {
  if (decision !== 'CHANGES_REQUESTED') return decision;
  const blocking = (latestReviews ?? []).some((review) => review.state === 'CHANGES_REQUESTED');
  return blocking ? decision : 'REVIEW_REQUIRED';
}

/**
 * One entry per check, keeping only the latest attempt of each.
 *
 * A rollup is every check run attached to the head commit, not the current state
 * of each check. Force-push onto a branch with a run still in flight — what
 * `gh stack` does to every layer above the one you edited — and GitHub cancels
 * that run and starts another on the same commit. Both stay attached, so the
 * rollup hands back a CANCELLED `test (0)` beside the SUCCESS that replaced it,
 * and counting both reports a green pull request as red. GitHub's own UI shows
 * the latest attempt and nothing else; so does this.
 *
 * Identity is the workflow plus the check's name, since a name like `test (0)`
 * is only unique within its workflow, and a legacy commit status has a context
 * instead. An entry naming neither is left alone rather than folded into one
 * bucket with every other anonymous entry.
 */
function latestAttempts(rollup: CheckRun[]): CheckRun[] {
  const startedAt = (check: CheckRun): string => check.startedAt ?? check.completedAt ?? '';
  const byCheck = new Map<string, CheckRun>();
  const unnamed: CheckRun[] = [];

  for (const check of rollup) {
    const label = check.name ?? check.context;
    if (label === undefined || label.length === 0) {
      unnamed.push(check);
      continue;
    }
    const key = `${check.workflowName ?? ''}\u0000${label}`;
    const seen = byCheck.get(key);
    // Ties go to the later entry: GitHub returns attempts oldest-first, and a
    // retry that starts in the same second as the cancellation is still the retry.
    if (seen !== undefined && startedAt(seen) > startedAt(check)) continue;
    byCheck.set(key, check);
  }
  return [...byCheck.values(), ...unnamed];
}

export function summariseChecks(
  rollup: CheckRun[] | undefined,
  ignorePattern = '',
): {
  state: ChecksState;
  detail: { passing: number; failing: number; pending: number };
} {
  const detail = { passing: 0, failing: 0, pending: 0 };
  if (!rollup || rollup.length === 0) return { state: 'none', detail };
  const ignore = ignoreMatcher(ignorePattern);

  for (const check of latestAttempts(rollup)) {
    // Advisory checks are dropped whole — see `ignoreChecksPattern`. A run's
    // name and a status's context are both tested because only one of them
    // exists per entry, and codecov arrives as the latter.
    const labels = [check.name, check.context, check.workflowName];
    if (ignore && labels.some((label) => label !== undefined && ignore.test(label))) continue;
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

/**
 * The second call per pull request: its head branch, review state and checks.
 *
 * Exported because a search cannot return a head ref — `headRefName` is not one
 * of the fields the search API offers — so anything that needs to know which
 * branch a pull request came from has to come through here.
 */
export async function enrichPr(pr: PullRequest): Promise<PullRequest> {
  const config = await loadConfig();
  const { code, stdout } = await run(
    'gh',
    [
      'pr',
      'view',
      String(pr.number),
      '-R',
      pr.repo,
      '--json',
      'headRefName,baseRefName,reviewDecision,latestReviews,additions,deletions,statusCheckRollup',
    ],
    { timeoutMs: 20_000 },
  );
  if (code !== 0) return pr;
  try {
    const view = JSON.parse(stdout) as ViewResult;
    const checks = summariseChecks(view.statusCheckRollup, config.github.ignoreChecksPattern);
    return {
      ...pr,
      branch: view.headRefName,
      base: view.baseRefName,
      reviewDecision: effectiveReviewDecision(view.reviewDecision, view.latestReviews),
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
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
  if (options.enrich !== false) all = await mapLimit(all, 6, enrichPr);

  const byRecency = (a: PullRequest, b: PullRequest): number => b.updatedAt.localeCompare(a.updatedAt);

  return {
    reviewRequested: all.filter((p) => p.roles.includes('review-requested')).sort(byRecency),
    mine: all.filter((p) => p.roles.includes('mine')).sort(byRecency),
    fetchedAt: Math.floor(Date.now() / 1000),
    degraded: reviewRows.length === 0 && mineRows.length === 0,
  };
}

/**
 * Split branch names into queries short enough for GitHub search to take.
 *
 * There is no documented ceiling on a search query, and 700-odd characters go
 * through fine, so this is a conservative bound rather than a discovered one —
 * a fleet of stacked tasks could otherwise build a query of any length at all.
 * Pure, and exported for its test.
 */
export function batchHeadQualifiers(branches: string[], maxChars = 600): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const branch of branches) {
    const cost = branch.length + 6; // `head:` plus the separating space.
    // A single branch longer than the budget still gets its own query: dropping
    // it would silently lose a pull request.
    if (current.length > 0 && length + cost > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(branch);
    length += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Every open PR whose head branch is one of `branches`, across the whole org.
 *
 * This is what makes a task's pull requests findable as a set: the convention
 * reuses one branch name in every repo a change touches, so a single search
 * returns the lot — including PRs opened by a teammate or from another machine,
 * which no local bookkeeping could know about. Stacked work needs the plural:
 * GitHub ORs repeated `head:` qualifiers, so a whole stack — a whole fleet of
 * them, in fact — is still one call rather than one per branch.
 *
 * `ok` is kept for the reason `searchRaw` keeps it: no pull requests open and a
 * broken `gh` look identical from the rows alone, and a task with nothing pushed
 * yet is the ordinary case here.
 */
export async function fetchPrsForBranches(
  branches: string[],
  limit = 60,
): Promise<{ ok: boolean; prs: PullRequest[] }> {
  if (branches.length === 0) return { ok: true, prs: [] };
  const config = await loadConfig();
  const extra = config.github.extraQualifiers.trim();

  const results = await Promise.all(
    batchHeadQualifiers(branches).map(async (batch) => {
      const args = [
        'search',
        'prs',
        ...batch.map((branch) => `head:${branch}`),
        '--state=open',
        `--limit=${limit}`,
        '--json',
        SEARCH_FIELDS,
      ];
      if (extra.length > 0) args.push(...extra.split(/\s+/));
      const { code, stdout } = await run('gh', args, { timeoutMs: 20_000 });
      if (code !== 0) return undefined;
      try {
        return JSON.parse(stdout) as SearchRow[];
      } catch {
        return undefined;
      }
    }),
  );

  // One failed batch means an incomplete answer, and an incomplete answer here
  // reads as "that PR was closed". Say degraded instead.
  if (results.some((rows) => rows === undefined)) return { ok: false, prs: [] };

  const byKey = new Map<string, PullRequest>();
  for (const row of results.flat() as SearchRow[]) {
    const pr = toPr(row, 'mine');
    if (!pr) continue;
    byKey.set(prKey(pr.repo, pr.number), { ...pr, roles: [] });
  }
  return { ok: true, prs: [...byKey.values()] };
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
