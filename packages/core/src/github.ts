import { run } from './exec.ts';
import { ghSearch } from './ghSearch.ts';
import { loadConfig } from './config.ts';
import type { DeployPatterns, MergedConfig } from './config.ts';

export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

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
  /**
   * Open, merged, or closed without merging.
   *
   * Absent from every search path — those are filtered to open pull requests at
   * the query, so there is nothing for the field to say. Present on the repo/ref
   * lookup, which deliberately asks for merged ones too: a task whose pull
   * requests have all landed has no open ones left, and without this that is
   * indistinguishable from a task that never opened any. See `taskStatus`.
   */
  state?: PrState;
  /** ISO timestamp, on a merged pull request only. */
  mergedAt?: string;
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
  // Through the gate, not straight to `gh` — see `ghSearch`. Every search in
  // the process shares one budget, so this is where the pacing has to live.
  const { ok, stdout } = await ghSearch(args);
  if (!ok) return { ok: false, rows: [] };
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
 * through fine, so `maxChars` is a conservative bound rather than a discovered
 * one — a fleet of stacked tasks could otherwise build a query of any length at
 * all. Pure, and exported for its test.
 *
 * `maxBranches` is the other bound, and it is the one that bites. `head:` terms
 * are OR-ed, so a batch's result set is the sum of every branch's matches
 * org-wide, against one `--limit` — and a truncated search is indistinguishable
 * from a branch having no pull request. Eighteen branches of a real fleet came
 * back capped, silently dropping three tasks' pull requests. Keeping a batch
 * small keeps its result set well under the cap; the caller also refuses an
 * answer that arrives at the limit, because no bound here can be certain.
 */
export function batchHeadQualifiers(branches: string[], maxChars = 600, maxBranches = 6): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const branch of branches) {
    const cost = branch.length + 6; // `head:` plus the separating space.
    // A single branch longer than the budget still gets its own query: dropping
    // it would silently lose a pull request.
    if (current.length > 0 && (length + cost > maxChars || current.length >= maxBranches)) {
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
  limit = 200,
  owners: string[] = [],
): Promise<{ ok: boolean; prs: PullRequest[] }> {
  if (branches.length === 0) return { ok: true, prs: [] };
  const config = await loadConfig();
  const extra = config.github.extraQualifiers.trim();

  const searchBatch = async (batch: string[]): Promise<SearchRow[] | undefined> => {
    const args = [
      'search',
      'prs',
      ...batch.map((branch) => `head:${branch}`),
      '--state=open',
      `--limit=${limit}`,
      '--json',
      SEARCH_FIELDS,
    ];
    // Bounded to the owners the fleet actually works in. A branch name like
    // `feature/new-app` exists in strangers' repositories too, and this search
    // is the one path allowed to match a repo no worktree holds — so without a
    // bound it hands back somebody else's pull request as the task's.
    for (const owner of owners) args.push('--owner', owner);
    if (extra.length > 0) args.push(...extra.split(/\s+/));
    const { ok, stdout } = await ghSearch(args);
    if (!ok) return undefined;
    let rows: SearchRow[];
    try {
      rows = JSON.parse(stdout) as SearchRow[];
    } catch {
      return undefined;
    }
    // A search that comes back full was cut off, and GitHub keeps whichever
    // rows it liked — so the branches that fell off look like branches with
    // no pull request. Split and retry when there is more than one branch; a
    // single branch that alone fills the limit is the one case we cannot
    // answer honestly, and that batch fails.
    if (rows.length >= limit) {
      if (batch.length <= 1) return undefined;
      const mid = Math.ceil(batch.length / 2);
      const [left, right] = await Promise.all([
        searchBatch(batch.slice(0, mid)),
        searchBatch(batch.slice(mid)),
      ]);
      if (left === undefined || right === undefined) return undefined;
      return [...left, ...right];
    }
    return rows;
  };

  const results = await Promise.all(batchHeadQualifiers(branches).map(searchBatch));

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

/** A branch in a repo we know the name of — the lookup a search was standing in for. */
export interface RepoBranch {
  /** `owner/name`. */
  repo: string;
  branch: string;
}

/**
 * How many `(repo, branch)` pairs ride in one GraphQL document.
 *
 * Each alias is a repository field asking for one pull request and up to a
 * hundred of its check contexts, so the node count — which is what GitHub
 * charges for — is about a hundred per pair. Forty keeps a document well inside
 * both the node ceiling and a readable size, and a fleet that needs a second
 * document is a fleet of eighty branches.
 */
const GRAPHQL_PAIRS_PER_QUERY = 40;

/** The rollup as GraphQL returns it: two shapes behind one union. */
interface GqlContext {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  context?: string;
  state?: string;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } } | null } | null;
}

interface GqlPr {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  state?: string;
  mergedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  author?: { login?: string } | null;
  latestReviews?: { nodes?: Array<{ state?: string } | null> | null } | null;
  commits?: {
    nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: Array<GqlContext | null> | null } } | null } } | null> | null;
  } | null;
}

interface GqlRepository {
  pullRequests?: { nodes?: Array<GqlPr | null> | null } | null;
}

/**
 * Flatten GraphQL's union back into the shape `summariseChecks` already reads.
 *
 * The REST rollup is one flat list where a check run carries `name`/`conclusion`
 * and a legacy commit status carries `context`/`state`; GraphQL splits those
 * into `CheckRun` and `StatusContext` and nests the workflow name two levels
 * down. Undoing that here rather than teaching the summariser a second shape
 * keeps one implementation of what counts as red — the part with the
 * force-push and retry subtleties in it.
 */
function toCheckRuns(pr: GqlPr): CheckRun[] {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const out: CheckRun[] = [];
  for (const node of nodes) {
    if (!node) continue;
    out.push({
      name: node.name,
      context: node.context,
      workflowName: node.checkSuite?.workflowRun?.workflow?.name,
      status: node.status,
      conclusion: node.conclusion,
      state: node.state,
      // A status has no start of its own; its creation is the closest thing,
      // and `latestAttempts` only ever compares these against each other.
      startedAt: node.startedAt ?? node.createdAt,
      completedAt: node.completedAt,
    });
  }
  return out;
}

function toPrFromGraphql(repo: string, node: GqlPr, ignorePattern: string): PullRequest {
  const checks = summariseChecks(toCheckRuns(node), ignorePattern);
  const reviews = (node.latestReviews?.nodes ?? []).filter((review): review is { state?: string } => review !== null);
  return {
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft,
    state: node.state === 'MERGED' || node.state === 'CLOSED' ? node.state : 'OPEN',
    mergedAt: node.mergedAt ?? undefined,
    author: node.author?.login,
    roles: [],
    branch: node.headRefName,
    base: node.baseRefName,
    reviewDecision: effectiveReviewDecision(node.reviewDecision ?? undefined, reviews),
    checks: checks.state,
    checksDetail: checks.detail,
    additions: node.additions,
    deletions: node.deletions,
  };
}

/** One aliased `repository` field. `JSON.stringify` is a valid GraphQL string literal. */
function repoBranchField(alias: string, pair: RepoBranch): string | undefined {
  const slash = pair.repo.indexOf('/');
  if (slash <= 0 || slash === pair.repo.length - 1) return undefined;
  const owner = pair.repo.slice(0, slash);
  const name = pair.repo.slice(slash + 1);
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequests(headRefName: ${JSON.stringify(pair.branch)}, states: [OPEN, MERGED], orderBy: { field: UPDATED_AT, direction: DESC }, first: 3) {
      nodes {
        number title url updatedAt isDraft state mergedAt headRefName baseRefName reviewDecision additions deletions
        author { login }
        latestReviews(last: 20) { nodes { state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state createdAt }
        } } } } } }
      }
    }
  }`;
}

export interface GqlPayload {
  data?: Record<string, GqlRepository | null> | null;
}

/**
 * Turn one GraphQL document's answer back into pull requests.
 *
 * Split out and pure because this is where the shape changes hands, and two
 * things about it are easy to get quietly wrong: which alias belongs to which
 * `(repo, branch)` pair — the repo is not in the response, only in the
 * question we asked — and the check union, where a run and a legacy status
 * arrive as different types and only one of the two is ever populated.
 *
 * A null alias is skipped rather than failing the document. GitHub answers
 * that way for a repo that has been renamed, deleted or is no longer visible,
 * alongside good data for every other alias.
 */
export function decodeRepoBranchPrs(
  payload: GqlPayload,
  pairs: RepoBranch[],
  ignorePattern = '',
): PullRequest[] {
  const out: PullRequest[] = [];
  for (const [alias, value] of Object.entries(payload.data ?? {})) {
    const index = Number.parseInt(alias.slice(1), 10);
    const pair = Number.isFinite(index) ? pairs[index] : undefined;
    if (pair === undefined) continue;
    for (const node of value?.pullRequests?.nodes ?? []) {
      if (node) out.push(toPrFromGraphql(pair.repo, node, ignorePattern));
    }
  }
  return out;
}

/**
 * The pull requests on branches whose repo we already know, in one call.
 *
 * Open *and* merged, which is a deliberate widening. A branch's merged pull
 * request is the only durable record that the work landed — the branch itself
 * falls back to zero commits ahead of the trunk and reads like one nobody ever
 * started — and asking for it here costs nothing: it is the same aliased field
 * on the same request, two extra states rather than a second round trip. The
 * merged-PR list in the deploy tab cannot stand in for it, since that one is
 * bounded by a lookback window and by `--involves=@me`.
 *
 * Closed-without-merging is left out on purpose. It is neither work in flight
 * nor work that landed, and counting it either way would misreport a task.
 *
 * This is the lookup a search was standing in for, and the difference is not
 * only volume. `head:` qualifiers OR'd together are an org-wide scatter query
 * on the one GitHub endpoint with a secondary throttle strict enough to refuse
 * a poll that has spent none of its published budget — and having refused it,
 * to keep refusing for minutes. A task's worktree already names its origin
 * remote, so for all but the branch nobody has cloned there is nothing to
 * search *for*: the repo and the ref are both known, and asking GitHub about a
 * ref it can look up directly is both cheaper and on the ordinary 5,000/hour
 * budget.
 *
 * It also collapses the second call per pull request. A search cannot return a
 * head ref, which is why every hit needed a `gh pr view` after it; here the
 * head ref, the base, the reviews and the whole check rollup arrive with the
 * pull request, so a fleet of twenty branches costs one request rather than
 * five searches and seventeen views.
 *
 * `ok` is kept for the reason every fetch here keeps it: no pull request open
 * and a broken `gh` produce the same empty list, and the caller must be able to
 * say `degraded` rather than "nothing is pushed".
 */
export async function fetchPrsForRepoBranches(
  pairs: RepoBranch[],
): Promise<{ ok: boolean; prs: PullRequest[] }> {
  if (pairs.length === 0) return { ok: true, prs: [] };
  const config = await loadConfig();

  const chunks: RepoBranch[][] = [];
  for (let i = 0; i < pairs.length; i += GRAPHQL_PAIRS_PER_QUERY) {
    chunks.push(pairs.slice(i, i + GRAPHQL_PAIRS_PER_QUERY));
  }

  const results = await Promise.all(
    chunks.map(async (chunk): Promise<PullRequest[] | undefined> => {
      const fields: string[] = [];
      const owners: RepoBranch[] = [];
      for (const pair of chunk) {
        const field = repoBranchField(`p${owners.length}`, pair);
        // A malformed `owner/name` is dropped rather than failing the chunk: it
        // would take every well-formed pair beside it down with it.
        if (field === undefined) continue;
        fields.push(field);
        owners.push(pair);
      }
      if (fields.length === 0) return [];

      const query = `query {\n${fields.join('\n')}\n}`;
      const { code, stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`], {
        timeoutMs: 30_000,
      });

      // Parsed before the exit code is consulted, on purpose. `gh` exits
      // non-zero when the response carries any `errors`, and a single renamed
      // or since-deleted repo produces exactly that beside perfectly good data
      // for every other alias. Losing the fleet's pull requests to one dead
      // remote is the failure this whole path exists to avoid.
      let payload: GqlPayload | undefined;
      try {
        payload = JSON.parse(stdout) as GqlPayload;
      } catch {
        payload = undefined;
      }
      if (!payload?.data) return code === 0 ? [] : undefined;
      return decodeRepoBranchPrs(payload, owners, config.github.ignoreChecksPattern);
    }),
  );

  // One failed chunk means an incomplete answer, and an incomplete answer here
  // reads as "that pull request was closed".
  if (results.some((rows) => rows === undefined)) return { ok: false, prs: [] };

  const byKey = new Map<string, PullRequest>();
  for (const pr of results.flat() as PullRequest[]) byKey.set(prKey(pr.repo, pr.number), pr);
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
