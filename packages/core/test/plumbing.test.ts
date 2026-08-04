import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionNameFor } from '../src/actions.ts';
import { summariseChecks } from '../src/github.ts';
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
