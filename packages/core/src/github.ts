import { run } from './exec.ts';
import { loadConfig } from './config.ts';

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

async function search(qualifier: string, limit: number): Promise<SearchRow[]> {
  const config = await loadConfig();
  const args = ['search', 'prs', qualifier, '--state=open', `--limit=${limit}`, '--json', SEARCH_FIELDS];
  if (config.github.extraQualifiers.trim().length > 0) {
    args.push(...config.github.extraQualifiers.trim().split(/\s+/));
  }
  const { code, stdout } = await run('gh', args, { timeoutMs: 20_000 });
  if (code !== 0) return [];
  try {
    return JSON.parse(stdout) as SearchRow[];
  } catch {
    return [];
  }
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
    search('--review-requested=@me', limit),
    search('--author=@me', limit),
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
