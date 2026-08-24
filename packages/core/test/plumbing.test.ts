import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionNameFor } from '../src/actions.ts';
import { summariseChecks } from '../src/github.ts';
import {
  byUrgencyThenRecency,
  classifyRun,
  isDone,
  isSettled,
  isTerminal,
  needsDeploy,
  patternsFor,
  summariseDeploy,
} from '../src/deployState.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { WorkflowRun } from '../src/deployState.ts';
import { parseRemote } from '../src/repoIndex.ts';
import { parseWorktrees, worktreeSlug } from '../src/worktree.ts';
import { prSessionName } from '../src/prSession.ts';

test('session names match what tmux-sessionizer already produces', () => {
  // The existing script is `basename | tr . _`. Diverging here would give one
  // project two sessions — one from prefix+g, one from fleetwood.
  assert.equal(sessionNameFor('/Users/k/projects/fleetwood'), 'fleetwood');
  assert.equal(sessionNameFor('/Users/k/projects/graphy.jj.zip'), 'graphy_jj_zip');
  assert.equal(sessionNameFor('/Users/k/dotfiles'), 'dotfiles');
  // tmux rejects colons in session names too.
  assert.equal(sessionNameFor('/tmp/weird:name'), 'weird_name');
});

test('parseRemote handles every remote URL shape', () => {
  assert.equal(parseRemote('git@github.com:bigbluedisco/atlas.git'), 'bigbluedisco/atlas');
  assert.equal(parseRemote('https://github.com/bigbluedisco/atlas.git'), 'bigbluedisco/atlas');
  assert.equal(parseRemote('https://github.com/bigbluedisco/atlas'), 'bigbluedisco/atlas');
  assert.equal(parseRemote('ssh://git@github.com/bigbluedisco/atlas.git'), 'bigbluedisco/atlas');
  assert.equal(parseRemote('git@github.com:Schroedinger-Hat/ImageGoNord-Web.git'), 'Schroedinger-Hat/ImageGoNord-Web');
  // Self-hosted paths with extra prefixes keep only the final owner/name.
  assert.equal(parseRemote('https://git.example.com/team/group/repo.git'), 'group/repo');
});

test('parseRemote rejects what it cannot understand instead of guessing', () => {
  assert.equal(parseRemote(''), undefined);
  assert.equal(parseRemote('   '), undefined);
  assert.equal(parseRemote('/local/path/repo'), undefined);
});

test('checks summary lets one failure dominate', () => {
  // A single red check is the thing you need to see, whatever else passed.
  assert.equal(
    summariseChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }]).state,
    'failing',
  );
  assert.equal(summariseChecks([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]).state, 'pending');
  assert.equal(summariseChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]).state, 'passing');
  assert.equal(summariseChecks([]).state, 'none');
  assert.equal(summariseChecks(undefined).state, 'none');
});

test('checks summary reads legacy commit statuses as well as check runs', () => {
  // Commit statuses use `state`; check runs use `status`/`conclusion`.
  assert.equal(summariseChecks([{ state: 'SUCCESS' }]).state, 'passing');
  assert.equal(summariseChecks([{ state: 'FAILURE' }]).state, 'failing');
  const detail = summariseChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'QUEUED' }]).detail;
  assert.deepEqual(detail, { passing: 1, failing: 1, pending: 1 });
});

test('worktree porcelain output parses into paths and branches', () => {
  // Verbatim `git worktree list --porcelain` shape, including a detached entry.
  const stdout = `worktree /Users/k/projects/atlas
HEAD abc123
branch refs/heads/dev

worktree /Users/k/projects/atlas/.agents/worktrees/pr-3671-fix-address-validation
HEAD def456
branch refs/heads/fix/address-validation

worktree /Users/k/projects/atlas/.agents/worktrees/detached
HEAD 999aaa
detached
`;
  const worktrees = parseWorktrees(stdout);
  assert.equal(worktrees.length, 3);
  assert.equal(worktrees[0]?.branch, 'dev');
  assert.equal(worktrees[1]?.branch, 'fix/address-validation');
  assert.equal(worktrees[1]?.path, '/Users/k/projects/atlas/.agents/worktrees/pr-3671-fix-address-validation');
  assert.equal(worktrees[2]?.branch, undefined, 'detached worktrees have no branch');
});

test('worktree slugs are filesystem-safe and stable per PR', () => {
  assert.equal(worktreeSlug(3671, 'fix/address-validation'), 'pr-3671-fix-address-validation');
  assert.equal(worktreeSlug(12, 'feature/DEV-1189_partial'), 'pr-12-feature-DEV-1189_partial');
  assert.equal(worktreeSlug(9, undefined), 'pr-9-head');
  // Same input, same slug — that is what makes reopening idempotent.
  assert.equal(worktreeSlug(3671, 'fix/address-validation'), worktreeSlug(3671, 'fix/address-validation'));
  assert.ok(!worktreeSlug(1, 'a/../../etc/passwd').includes('/'), 'no path traversal in a slug');
});

test('PR session names are derived from the repo, not the whole slug', () => {
  assert.equal(prSessionName('bigbluedisco/atlas', 3671), 'atlas-pr-3671');
  assert.equal(prSessionName('bigbluedisco/atlas-ui', 2346), 'atlas-ui-pr-2346');
});

// --- merge → build → deploy roll-up ----------------------------------------

const MERGED = DEFAULT_CONFIG.github.merged;
const PATTERNS = patternsFor('bigbluedisco/anything', MERGED);

/** Build a run list the way `gh run list --commit` hands it over. */
function runs(...rows: Array<[name: string, status: string, conclusion: string, headBranch?: string]>): WorkflowRun[] {
  return rows.map(([name, status, conclusion, headBranch]) => ({
    name,
    role: classifyRun(name, PATTERNS),
    status,
    conclusion,
    headBranch: headBranch ?? 'dev',
    url: `https://github.com/x/y/actions/runs/1#${name}`,
  }));
}

test('deploy is read before build, so build_and_deploy is not a build', () => {
  // Reading `build_and_deploy` as a build would tell you to ship a frontend
  // that is already live — the one mistake this whole feature exists to avoid.
  assert.equal(classifyRun('build_and_deploy', PATTERNS), 'deploy');
  assert.equal(classifyRun('Deploy to Firebase Hosting on merge', PATTERNS), 'deploy');
  assert.equal(classifyRun('Production deploy to Firebase Hosting', PATTERNS), 'deploy');
  assert.equal(classifyRun('Docker build', PATTERNS), 'build');
  assert.equal(classifyRun('Node.js Package', PATTERNS), 'build');
  assert.equal(classifyRun('Copy Go bindings to atlas-proto-go', PATTERNS), 'build');
  assert.equal(classifyRun('Test and lint', PATTERNS), 'check');
  assert.equal(classifyRun('Autotag', PATTERNS), 'check');
  assert.equal(classifyRun('Check', PATTERNS), 'check');
});

test('a Go repo merge reads as built, with the tag Autotag pushed', () => {
  // Verbatim from `gh run list --commit` on reflow#10397's merge commit. The
  // Docker build is triggered by the tag, yet still carries the merge SHA — that
  // linkage is the whole reason one query can see the entire chain.
  const rollup = summariseDeploy(
    runs(
      ['Docker build', 'completed', 'success', 'v1.2110.3'],
      ['Autotag', 'completed', 'success'],
      ['Test and lint', 'completed', 'success'],
    ),
    { settled: true },
  );
  assert.equal(rollup.state, 'built');
  assert.equal(rollup.tag, 'v1.2110.3');
  assert.equal(rollup.decidedBy?.name, 'Docker build');
});

test('atlas keeps Docker build decisive among its other tag-triggered runs', () => {
  // atlas#3676: two package-publishing runs fire on the same tag. Neither is
  // what you deploy, and neither may drown out the image.
  const rollup = summariseDeploy(
    runs(
      ['Copy Go bindings to atlas-proto-go', 'completed', 'success', 'v0.786.3'],
      ['Node.js Package', 'completed', 'success', 'v0.786.3'],
      ['Docker build', 'completed', 'success', 'v0.786.3'],
      ['Autotag', 'completed', 'success'],
      ['Test and lint', 'completed', 'success'],
    ),
    { settled: true },
  );
  assert.equal(rollup.state, 'built');
  assert.equal(rollup.tag, 'v0.786.3');
});

test('a frontend merge reads as deployed, not as something to ship', () => {
  // atlas-ui#2376: a staging deploy on push plus a production deploy chained off
  // Autotag. Two deploys still mean one answer.
  const rollup = summariseDeploy(
    runs(
      ['Production deploy to Firebase Hosting', 'completed', 'success'],
      ['Autotag', 'completed', 'success'],
      ['Check', 'completed', 'success'],
      ['Deploy to Firebase Hosting on merge', 'completed', 'success'],
    ),
    { settled: true },
  );
  assert.equal(rollup.state, 'deployed');
  assert.equal(rollup.tag, undefined);
});

test('an in-flight build outranks a green one from the same merge', () => {
  assert.equal(
    summariseDeploy(runs(['Docker build', 'in_progress', '', 'v1.0.0']), { settled: true }).state,
    'building',
  );
  assert.equal(
    summariseDeploy(runs(['Deploy to Firebase Hosting on merge', 'queued', '']), { settled: true }).state,
    'deploying',
  );
  // Still building beats already built: the image you'd ship isn't final yet.
  const mixed = summariseDeploy(
    runs(['Docker build', 'completed', 'success', 'v1.0.0'], ['Docker build', 'in_progress', '', 'v1.0.0']),
    { settled: true },
  );
  assert.equal(mixed.state, 'building');
});

test('red dominates, and a red check counts because no tag will follow it', () => {
  assert.equal(
    summariseDeploy(runs(['Docker build', 'completed', 'failure', 'v1.0.0']), { settled: true }).state,
    'failed',
  );
  // A failed `Test and lint` on the base branch means Autotag never fires, so
  // there is no tag and no image coming. "Still checking" would be a lie.
  assert.equal(
    summariseDeploy(runs(['Test and lint', 'completed', 'failure']), { settled: true }).state,
    'failed',
  );
  // But a red check with a green build after it is history, not a problem.
  assert.equal(
    summariseDeploy(
      runs(['Test and lint', 'completed', 'failure'], ['Docker build', 'completed', 'success', 'v1.0.0']),
      { settled: true },
    ).state,
    'built',
  );
});

test('a skipped build built nothing', () => {
  // `skipped` reads as a pass for PR checks, but it must not read as an artifact.
  assert.equal(
    summariseDeploy(runs(['Docker build', 'completed', 'skipped']), { settled: true }).state,
    'none',
  );
});

test('silence right after a merge is latency, not an answer', () => {
  // The chain is test → autotag → tag push → build, so an absent build inside
  // the settle window means "not yet". Past it, it means the trail stopped.
  assert.equal(summariseDeploy([], { settled: false }).state, 'checking');
  assert.equal(summariseDeploy([], { settled: true }).state, 'none');
  assert.equal(
    summariseDeploy(runs(['Test and lint', 'in_progress', '']), { settled: false }).state,
    'checking',
  );
  const tagCut = runs(['Autotag', 'completed', 'success'], ['Test and lint', 'completed', 'success']);
  assert.equal(summariseDeploy(tagCut, { settled: false }).state, 'waiting');
  // Once settled with nothing downstream, say so rather than waiting forever.
  assert.equal(summariseDeploy(tagCut, { settled: true }).state, 'none');
});

test('a per-repo override rescues a repo whose workflow name says nothing', () => {
  // storage-mysql-bridge builds and deploys in a workflow called `CI`; its
  // *job* is the thing called `deploy`, which run-level data never shows.
  const repo = 'bigbluedisco/storage-mysql-bridge';
  const config = { ...MERGED, repos: { [repo]: { deployPattern: '^CI$' } } };
  const patterns = patternsFor(repo, config);
  assert.equal(classifyRun('CI', patterns), 'deploy');
  assert.equal(classifyRun('Go Lint', patterns), 'check');
  // Untouched repos keep the defaults.
  assert.equal(classifyRun('CI', patternsFor('bigbluedisco/atlas', config)), 'check');
});

test('a broken user-supplied pattern falls back instead of taking the list down', () => {
  const patterns = patternsFor('x/y', { ...MERGED, repos: { 'x/y': { deployPattern: '([' } } });
  assert.equal(classifyRun('Deploy everything', patterns), 'check');
});

test('only states nothing can change are treated as terminal', () => {
  for (const state of ['deployed', 'built', 'failed', 'none'] as const) {
    assert.equal(isTerminal(state), true, state);
  }
  for (const state of ['checking', 'waiting', 'building', 'deploying'] as const) {
    assert.equal(isTerminal(state), false, state);
  }
});

test('the settle window is measured from the merge, and survives a bad date', () => {
  const now = Date.parse('2026-08-24T15:30:00Z');
  assert.equal(isSettled('2026-08-24T15:29:00Z', 15, now), false);
  assert.equal(isSettled('2026-08-24T15:00:00Z', 15, now), true);
  // An unparseable timestamp must not pin a row to "still checking" forever.
  assert.equal(isSettled('', 15, now), true);
});

test('a hand-mark is what settles a built image, and it outranks the CI state', () => {
  // CI can only ever say "image pushed" for the Go services, so marking it is the
  // only way the row can ever read as finished.
  const built = { deploy: { state: 'built' as const }, mergedAt: '2026-08-24T15:00:00Z' };
  assert.equal(needsDeploy(built), true);
  assert.equal(isDone(built), false);

  const shipped = { ...built, deployedByHand: 1_700_000_000 };
  assert.equal(needsDeploy(shipped), false);
  assert.equal(isDone(shipped), true);

  // A frontend needs no mark: its deploy run already said so.
  assert.equal(isDone({ deploy: { state: 'deployed' as const } }), true);
  // And a mark on a failed build still counts — you may have shipped by hand.
  assert.equal(isDone({ deploy: { state: 'failed' as const }, deployedByHand: 1 }), true);
});

test('what is still owed sorts above what is finished, newest first inside each', () => {
  const rows = [
    { deploy: { state: 'deployed' as const }, mergedAt: '2026-08-24T12:00:00Z' },
    { deploy: { state: 'built' as const }, mergedAt: '2026-08-20T12:00:00Z' },
    { deploy: { state: 'built' as const }, mergedAt: '2026-08-24T09:00:00Z', deployedByHand: 1 },
    { deploy: { state: 'building' as const }, mergedAt: '2026-08-23T12:00:00Z' },
  ];
  const sorted = [...rows].sort(byUrgencyThenRecency);
  assert.deepEqual(
    sorted.map((r) => `${r.deploy.state}${r.deployedByHand ? '+hand' : ''}`),
    ['building', 'built', 'deployed', 'built+hand'],
  );
  // The marked one sank below the unmarked build even though it merged later.
  assert.equal(sorted[3]?.deployedByHand, 1);
});
