import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fleetOwners,
  matchPrsToTasks,
  parseAheadBehind,
  parseCheckoutBranches,
  prCacheKey,
  repoBranchPairs,
  trunkBranchName,
  unclonedBranchNames,
} from '../src/taskPrs.ts';
import type { TaskBranches } from '../src/taskPrs.ts';
import { batchHeadQualifiers } from '../src/github.ts';
import type { PullRequest } from '../src/github.ts';
import { prSummary } from '../src/taskView.ts';

/** A search hit, enriched — only the fields the matcher reads are meaningful. */
function pr(repo: string, number: number, branch?: string): PullRequest {
  return {
    repo,
    number,
    title: branch ?? `#${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    updatedAt: '2026-08-27T10:00:00Z',
    isDraft: false,
    roles: [],
    branch,
  };
}

test('both sides of every checkout come out of a reflog, deduped and in order', () => {
  const log = [
    'checkout: moving from main to feature/orders-use-order-type',
    'commit: use the type',
    'checkout: moving from feature/orders-use-order-type to feature/orders-dual-write-order-type',
    'checkout: moving from feature/orders-dual-write-order-type to feature/orders-use-order-type',
  ].join('\n');
  assert.deepEqual(parseCheckoutBranches(log), [
    'main',
    'feature/orders-use-order-type',
    'feature/orders-dual-write-order-type',
  ]);
});

test('a detached checkout names a commit, which is not a branch to search for', () => {
  const log = [
    'checkout: moving from main to 3870782',
    'checkout: moving from 3870782dd0f1a2b3c4d5e6f708192a3b4c5d6e7f to fix/thing',
  ].join('\n');
  assert.deepEqual(parseCheckoutBranches(log), ['main', 'fix/thing']);
});

test('reflog lines that are not checkouts are ignored', () => {
  const log = ['commit: something', 'reset: moving to HEAD', 'rebase (finish): returning to refs/heads/x'].join('\n');
  assert.deepEqual(parseCheckoutBranches(log), []);
});

test('ahead-behind is read per branch, and unparseable lines are skipped', () => {
  const out = parseAheadBehind(
    ['dev 0 0', 'feature/orders-use-order-type 6 5', 'feature/no-base ', ''].join('\n'),
  );
  assert.equal(out.size, 2);
  assert.deepEqual(out.get('feature/orders-use-order-type'), { ahead: 6, behind: 5 });
  assert.equal(out.get('feature/no-base'), undefined);
});

test('head qualifiers are batched to a length GitHub will take, losing none', () => {
  const branches = Array.from({ length: 40 }, (_, i) => `feature/orders-a-fairly-long-branch-name-${i}`);
  const batches = batchHeadQualifiers(branches, 300);
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    const query = batch.map((b) => `head:${b}`).join(' ');
    assert.ok(query.length <= 300 || batch.length === 1, `batch too long: ${query.length}`);
  }
  assert.deepEqual(batches.flat(), branches);
});

test('one branch longer than the budget still gets searched for', () => {
  const long = `feature/${'x'.repeat(400)}`;
  assert.deepEqual(batchHeadQualifiers([long], 100), [[long]]);
});

test('nothing to search for is one empty batch list, not one empty query', () => {
  assert.deepEqual(batchHeadQualifiers([]), []);
});

test('a batch is capped by branch count as well as by length', () => {
  // `head:` terms are OR-ed, so a batch's result set is every branch's matches
  // added together against one `--limit`. Eighteen short branches fitted the
  // character budget in a single query and came back truncated, which reads as
  // three tasks having no pull requests at all.
  const branches = Array.from({ length: 18 }, (_, i) => `feature/b-${i}`);
  const batches = batchHeadQualifiers(branches);
  assert.ok(batches.length >= 3, `expected several batches, got ${batches.length}`);
  for (const batch of batches) assert.ok(batch.length <= 6, `batch of ${batch.length} is too wide`);
  assert.deepEqual(batches.flat(), branches, 'no branch is dropped');
});

test('the trunk name compared to candidates is bare, not origin-prefixed', () => {
  // discoverTaskBranches used to skip `origin/main` and let bare `main` through
  // (from `git branch --contains` after a land). Searching `head:main` then
  // returned hundreds of org-wide hits and starved every other branch in the batch.
  assert.equal(trunkBranchName('origin/main'), 'main');
  assert.equal(trunkBranchName('origin/dev'), 'dev');
  assert.equal(trunkBranchName('main'), 'main');
  assert.equal(trunkBranchName(undefined), undefined);
});

const stacked: TaskBranches = {
  slug: 'order-type-filling',
  branches: [
    {
      branch: 'feature/orders-use-order-type',
      repoName: 'reflow-orders-use-order-type',
      repo: 'bigbluedisco/reflow',
      via: 'head',
      ahead: 6,
    },
    {
      branch: 'feature/orders-dual-write-order-type',
      repoName: 'reflow-orders-dual-write-order-type',
      repo: 'bigbluedisco/reflow',
      via: 'head',
      ahead: 9,
    },
    {
      branch: 'feature/orders-backfill-order-type',
      repoName: 'reflow-orders-use-order-type',
      repo: 'bigbluedisco/reflow',
      via: 'stack',
      ahead: 14,
    },
    { branch: 'feature/orders-use-order-type', via: 'task' },
  ],
};

test('a stack is listed bottom first, by how far each branch is from the default', () => {
  const byTask = matchPrsToTasks(
    [stacked],
    [
      pr('bigbluedisco/reflow', 10412, 'feature/orders-backfill-order-type'),
      pr('bigbluedisco/reflow', 10410, 'feature/orders-use-order-type'),
      pr('bigbluedisco/reflow', 10420, 'feature/orders-dual-write-order-type'),
    ],
  );
  assert.deepEqual(
    byTask['order-type-filling']?.map((p) => p.number),
    [10410, 10420, 10412],
  );
});

test('a branch found in a worktree is described by that worktree, not by the task', () => {
  const byTask = matchPrsToTasks([stacked], [pr('bigbluedisco/reflow', 10410, 'feature/orders-use-order-type')]);
  const found = byTask['order-type-filling']?.[0];
  assert.equal(found?.via, 'head');
  assert.equal(found?.repoName, 'reflow-orders-use-order-type');
});

test('the same branch name in another repo is not this task\'s — unless it is the task branch', () => {
  const byTask = matchPrsToTasks(
    [stacked],
    [
      // Same name, different repo: only reachable through the 'task' entry, which
      // is exactly the cross-repo case the branch convention exists for.
      pr('bigbluedisco/graphy', 7, 'feature/orders-use-order-type'),
      // A stack branch is repo-specific, so a namesake elsewhere is a coincidence.
      pr('bigbluedisco/graphy', 8, 'feature/orders-backfill-order-type'),
    ],
  );
  assert.deepEqual(
    byTask['order-type-filling']?.map((p) => `${p.repo}#${p.number}`),
    ['bigbluedisco/graphy#7'],
  );
  assert.equal(byTask['order-type-filling']?.[0]?.via, 'task');
});

test('a pull request on no known branch belongs to no task', () => {
  const byTask = matchPrsToTasks(
    [stacked],
    [pr('bigbluedisco/reflow', 99, 'feature/something-else'), pr('bigbluedisco/reflow', 98)],
  );
  assert.deepEqual(byTask, {});
});

test('a task with no matching pull requests is absent rather than empty', () => {
  const byTask = matchPrsToTasks(
    [stacked, { slug: 'quiet', branches: [{ branch: 'feature/quiet', via: 'task' }] }],
    [pr('bigbluedisco/reflow', 10410, 'feature/orders-use-order-type')],
  );
  assert.deepEqual(Object.keys(byTask), ['order-type-filling']);
});

test('a branch whose repo could not be read is kept, not dropped', () => {
  const byTask = matchPrsToTasks(
    [{ slug: 't', branches: [{ branch: 'feature/x', repoName: 'thing', via: 'head', ahead: 2 }] }],
    [pr('someone/thing', 1, 'feature/x')],
  );
  assert.equal(byTask['t']?.length, 1);
});

test('two tasks sharing a branch both list its pull request', () => {
  const byTask = matchPrsToTasks(
    [
      { slug: 'a', branches: [{ branch: 'feature/shared', via: 'task' }] },
      { slug: 'b', branches: [{ branch: 'feature/shared', via: 'task' }] },
    ],
    [pr('bigbluedisco/reflow', 1, 'feature/shared')],
  );
  assert.deepEqual(Object.keys(byTask).sort(), ['a', 'b']);
});

test('the enrichment cache key moves when the pull request does', () => {
  const before = pr('bigbluedisco/reflow', 10410, 'feature/orders-use-order-type');
  const after = { ...before, updatedAt: '2026-08-27T11:00:00Z' };
  assert.notEqual(prCacheKey(before), prCacheKey(after));
  assert.equal(prCacheKey(before), prCacheKey({ ...before, title: 'renamed' }));
});

test('the summary counts only what asks something of you', () => {
  const base = pr('r', 1, 'b');
  assert.equal(prSummary([{ ...base, via: 'head', branch: 'b' }]), '1 open');
  assert.equal(
    prSummary([
      { ...base, via: 'head', branch: 'b', checks: 'failing' },
      { ...base, number: 2, via: 'head', branch: 'c', reviewDecision: 'APPROVED' },
      { ...base, number: 3, via: 'head', branch: 'd', checks: 'pending' },
    ]),
    '3 open · 1 failing · 1 approved',
  );
});

/** A discovered branch set, as `discoverTaskBranches` would hand it over. */
function branches(slug: string, entries: TaskBranches['branches']): TaskBranches {
  return { slug, branches: entries };
}

test('a branch whose worktree named its remote is a lookup, not a search', () => {
  const sets = [
    branches('receive', [
      { branch: 'feature/receive-a', via: 'head', repoName: 'atlas-a', repo: 'bigbluedisco/atlas' },
      { branch: 'feature/receive-b', via: 'stack', repoName: 'atlas-a', repo: 'bigbluedisco/atlas' },
      { branch: 'feature/receive', via: 'task' },
    ]),
  ];
  assert.deepEqual(repoBranchPairs(sets), [
    { repo: 'bigbluedisco/atlas', branch: 'feature/receive-a' },
    { repo: 'bigbluedisco/atlas', branch: 'feature/receive-b' },
  ]);
  assert.deepEqual(unclonedBranchNames(sets), ['feature/receive']);
});

test('the same pair in two tasks is asked about once', () => {
  // Stacked tasks share their lower layers, and the naming convention reuses
  // one branch name across repos — both make duplicates the normal case.
  const sets = [
    branches('lower', [{ branch: 'feature/x', via: 'head', repo: 'org/repo' }]),
    branches('upper', [
      { branch: 'feature/x', via: 'stack', repo: 'org/repo' },
      { branch: 'feature/y', via: 'head', repo: 'org/repo' },
    ]),
  ];
  assert.deepEqual(repoBranchPairs(sets), [
    { repo: 'org/repo', branch: 'feature/x' },
    { repo: 'org/repo', branch: 'feature/y' },
  ]);
});

test('a name already looked up in a real repo is not searched for as well', () => {
  // The task entry is deliberately repo-less, but when a worktree in the task
  // is on that very branch the lookup has already covered it. Searching it
  // again would spend the one throttled call on an answer we hold.
  const sets = [
    branches('task', [
      { branch: 'fix/thing', via: 'head', repoName: 'repo-thing', repo: 'org/repo' },
      { branch: 'fix/thing', via: 'task' },
    ]),
  ];
  assert.deepEqual(unclonedBranchNames(sets), []);
});

test('a worktree whose remote git would not name falls back to the search', () => {
  const sets = [
    branches('local', [
      { branch: 'feature/local', via: 'head', repoName: 'octoposte-local' },
      { branch: 'feature/local', via: 'task' },
    ]),
  ];
  assert.deepEqual(repoBranchPairs(sets), []);
  assert.deepEqual(unclonedBranchNames(sets), ['feature/local']);
});

test('a stranger\'s repo with the same branch name is not the task\'s pull request', () => {
  // `feature/new-app` is a name other people use. The task entry is allowed to
  // match a repo the folder does not hold, so without an owner bound the
  // org-wide search files a stranger's pull request under the task.
  const sets = [
    branches('new-app', [
      { branch: 'feature/new-app', via: 'head', repoName: 'graphy-new-app', repo: 'bigbluedisco/graphy' },
      { branch: 'feature/new-app', via: 'task' },
    ]),
  ];
  const prs = [pr('rummyze/boxfuse-sample-java-war-hello', 1, 'feature/new-app')];
  assert.deepEqual(matchPrsToTasks(sets, prs, ['bigbluedisco']), {});
});

test('a teammate\'s pull request in an uncloned repo of the fleet\'s own org still counts', () => {
  const sets = [branches('orders', [{ branch: 'fix/orders', via: 'task' }])];
  const prs = [pr('bigbluedisco/reflow', 42, 'fix/orders')];
  const matched = matchPrsToTasks(sets, prs, ['bigbluedisco']);
  assert.deepEqual(
    (matched['orders'] ?? []).map((entry) => [entry.repo, entry.number, entry.via]),
    [['bigbluedisco/reflow', 42, 'task']],
  );
});

test('no owner readable from git narrows nothing, rather than everything', () => {
  // Every worktree local-only: silence about owners must not be read as "no
  // owner is legitimate", which would drop the task's real pull requests.
  const sets = [branches('local', [{ branch: 'feature/local', via: 'task' }])];
  const prs = [pr('someone/repo', 3, 'feature/local')];
  assert.equal((matchPrsToTasks(sets, prs, [])['local'] ?? []).length, 1);
});

test('the owner allowlist is the whole fleet, not one task', () => {
  const sets = [
    branches('a', [{ branch: 'feature/a', via: 'head', repo: 'bigbluedisco/atlas' }]),
    branches('b', [{ branch: 'feature/b', via: 'head', repo: 'kiliandbigblue/fleetwood' }]),
    branches('c', [{ branch: 'feature/c', via: 'task' }]),
  ];
  assert.deepEqual(fleetOwners(sets), ['bigbluedisco', 'kiliandbigblue']);
});
