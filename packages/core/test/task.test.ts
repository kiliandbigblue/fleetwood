import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchToSlug,
  buildBranch,
  linkTaskSkills,
  matchTaskRepo,
  renderBrief,
  readTaskNotes,
  readTaskRepos,
  slugify,
  writeNotesFile,
} from '../src/task.ts';
import { mainCheckoutFor, removeWorktree, remoteNameWithOwner } from '../src/worktree.ts';
import { run } from '../src/exec.ts';

test('branch names follow the <type>/<microservice>-<summary> convention', () => {
  // The microservice is a domain, not a repo — which is why the same branch name
  // gets reused in every repo the change touches.
  assert.equal(buildBranch('fix', 'flow', 'execution labels'), 'fix/flow-execution-labels');
  assert.equal(
    buildBranch('feature', 'merchantportal', 'packaging search index'),
    'feature/merchantportal-packaging-search-index',
  );
  assert.equal(buildBranch('chore', 'ui', 'tokens page'), 'chore/ui-tokens-page');
});

test('branch building tolerates messy input', () => {
  assert.equal(buildBranch('Fix', 'Flow', 'Execution  Labels!'), 'fix/flow-execution-labels');
  assert.equal(buildBranch('feature', 'flow', 'add "pick" variable'), 'feature/flow-add-pick-variable');
  // An accented summary must still produce a valid git ref.
  assert.equal(buildBranch('fix', 'mrw', 'césar observaciones'), 'fix/mrw-cesar-observaciones');
});

test('a missing type falls back rather than producing a bare slug', () => {
  assert.equal(buildBranch('', 'flow', 'labels'), 'feature/flow-labels');
});

test('a missing microservice still yields a usable branch', () => {
  assert.equal(buildBranch('fix', '', 'stray whitespace'), 'fix/stray-whitespace');
});

test('slugify produces valid git ref components', () => {
  const nasty = 'Feature: add ~caret^ and [bracket] and ..dots.. and a\\backslash';
  const slug = slugify(nasty);
  // git check-ref-format rejects all of these; none may survive.
  for (const bad of ['~', '^', ':', '?', '*', '[', ']', '\\', '..', ' ']) {
    assert.ok(!slug.includes(bad), `${bad} survived slugify: ${slug}`);
  }
  assert.ok(!slug.startsWith('-') && !slug.endsWith('-'));
});

test('slugify is bounded so paths and refs stay sane', () => {
  assert.ok(slugify('a'.repeat(200)).length <= 60);
});

test('the task folder name is the branch without its type prefix', () => {
  assert.equal(branchToSlug('fix/flow-execution-labels'), 'flow-execution-labels');
  assert.equal(branchToSlug('feature/merchantportal-packaging'), 'merchantportal-packaging');
  // A branch with no type prefix is still usable.
  assert.equal(branchToSlug('hotfix-now'), 'hotfix-now');
  // Only the first segment is the type; the rest keeps its shape.
  assert.equal(branchToSlug('feature/DEV-1189/partial-modal'), 'dev-1189-partial-modal');
});

test('slug and branch round-trip for the same task description', () => {
  const branch = buildBranch('fix', 'flow', 'execution labels');
  assert.equal(branchToSlug(branch), 'flow-execution-labels');
  // Rebuilding from the same inputs is stable — that is what makes createTask
  // idempotent by slug.
  assert.equal(buildBranch('fix', 'flow', 'execution labels'), branch);
});

test('notes round-trip through the task folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-notes-'));
  assert.equal(await readTaskNotes(dir), undefined);

  await writeNotesFile(dir, 'check the trip id, several truck loads share one');
  assert.match((await readTaskNotes(dir)) ?? '', /several truck loads/);

  // Blank input removes the file: "no notes" must be one state on disk, not two.
  await writeNotesFile(dir, '   \n  ');
  assert.equal(await readTaskNotes(dir), undefined);
  assert.deepEqual(await readdir(dir), []);
});

test('a whitespace-only NOTES.md reads as no notes at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-notes-'));
  await writeFile(join(dir, 'NOTES.md'), '\n\n  \n', 'utf8');
  assert.equal(await readTaskNotes(dir), undefined);
});

test('NOTES.md is not mistaken for a repo in the task folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-notes-'));
  await writeNotesFile(dir, 'do not list me as a worktree');
  assert.deepEqual(await readTaskRepos(dir), []);
});

/** A repo worktree holding one skill, in whichever tree it keeps them. */
async function repoWithSkill(
  dir: string,
  name: string,
  tree: string,
  skill: string,
): Promise<{ name: string; path: string; dirty: number }> {
  const path = join(dir, name);
  await mkdir(join(path, tree, skill), { recursive: true });
  await writeFile(join(path, tree, skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`, 'utf8');
  return { name, path, dirty: 0 };
}

test("a repo's skills are linked into the task folder for both agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const repo = await repoWithSkill(dir, 'fleetwood', '.claude/skills', 'relaunch-app');

  assert.deepEqual(await linkTaskSkills(dir, [repo]), ['relaunch-app']);

  // Claude reads one tree, Cursor the other; the skill has to be in both.
  for (const tree of ['.claude/skills', '.agents/skills']) {
    const link = join(dir, tree, 'relaunch-app');
    // Relative, so the task folder stays movable.
    assert.equal(await readlink(link), join('..', '..', 'fleetwood', '.claude/skills', 'relaunch-app'));
    assert.match(await readFile(join(link, 'SKILL.md'), 'utf8'), /name: relaunch-app/);
  }
});

test('a skill reachable through both trees is linked once, from the canonical one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const repo = await repoWithSkill(dir, 'atlas', '.agents/skills', 'deploy');
  // What a repo following the convention looks like: `.claude` only points at it.
  await mkdir(join(repo.path, '.claude/skills'), { recursive: true });
  await symlink(join('..', '..', '.agents/skills', 'deploy'), join(repo.path, '.claude/skills/deploy'));

  assert.deepEqual(await linkTaskSkills(dir, [repo]), ['deploy']);
  // `.agents` is read first, so that is the path the link names.
  assert.equal(
    await readlink(join(dir, '.claude/skills/deploy')),
    join('..', '..', 'atlas', '.agents/skills', 'deploy'),
  );
});

test('two repos claiming one skill name: the first keeps it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const first = await repoWithSkill(dir, 'atlas', '.claude/skills', 'deploy');
  const second = await repoWithSkill(dir, 'graphy', '.claude/skills', 'deploy');

  assert.deepEqual(await linkTaskSkills(dir, [first, second]), ['deploy']);
  // `name:` in the frontmatter must match its folder, so the loser cannot be
  // renamed aside — it stays reachable at its own path instead.
  assert.match(await readlink(join(dir, '.claude/skills/deploy')), /atlas/);
});

test('a repo that left the task takes its links with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const staying = await repoWithSkill(dir, 'fleetwood', '.claude/skills', 'relaunch-app');
  const leaving = await repoWithSkill(dir, 'proto', '.claude/skills', 'regenerate');

  await linkTaskSkills(dir, [staying, leaving]);
  assert.deepEqual(await linkTaskSkills(dir, [staying]), ['relaunch-app']);
  assert.deepEqual((await readdir(join(dir, '.claude/skills'))).sort(), ['relaunch-app']);
});

test('linking leaves a hand-made skill directory alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const repo = await repoWithSkill(dir, 'fleetwood', '.claude/skills', 'relaunch-app');
  // Not a symlink, so not ours to remove.
  await mkdir(join(dir, '.claude/skills', 'mine'), { recursive: true });

  await linkTaskSkills(dir, [repo]);
  assert.ok((await lstat(join(dir, '.claude/skills', 'mine'))).isDirectory());
});

test('a directory without a SKILL.md is not a skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  const path = join(dir, 'fleetwood');
  await mkdir(join(path, '.claude/skills', 'notes'), { recursive: true });

  assert.deepEqual(await linkTaskSkills(dir, [{ name: 'fleetwood', path, dirty: 0 }]), []);
});

test('the linked skills are not mistaken for repos in the task folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-skills-'));
  await mkdir(join(dir, '.claude/skills'), { recursive: true });
  await mkdir(join(dir, '.agents/skills'), { recursive: true });
  assert.deepEqual(await readTaskRepos(dir), []);
});

const RECORD = {
  version: 1,
  slug: 'flow-execution-labels',
  branch: 'fix/flow-execution-labels',
  type: 'fix',
  microservice: 'flow',
  summary: 'execution labels',
  createdAt: 0,
} as const;

test('the brief lists the skills the task folder linked in', () => {
  const brief = renderBrief(RECORD, [], ['relaunch-app', 'spawn-worktree']);
  assert.match(brief, /## Skills from these repos/);
  assert.match(brief, /- `\/relaunch-app`/);
  assert.match(brief, /- `\/spawn-worktree`/);
  // The paragraph about a repo's own config not loading has to stop short of
  // claiming the same about skills, now that they do.
  assert.match(brief, /Skills are the\n.*one exception/);
});

test('no skills, no section — an empty heading would read as a gap', () => {
  assert.doesNotMatch(renderBrief(RECORD, []), /## Skills from these repos/);
});

test("a worktree not named after its repo still resolves the repo it belongs to", async () => {
  // The stacked-work layout: one directory per branch, so the directory name is
  // the branch's, never the repo's. Nothing in the repo index matches it, and
  // without the remote fallback `archiveTask` cannot find the owning checkout —
  // it keeps every worktree with "owning repo not found".
  const dir = await mkdtemp(join(tmpdir(), 'fw-repo-name-'));
  const worktree = join(dir, 'reflow-orders-drop-b2b-flag');
  await mkdir(worktree, { recursive: true });
  await run('git', ['-C', worktree, 'init', '-q']);
  await run('git', ['-C', worktree, 'remote', 'add', 'origin', 'git@github.com:bigbluedisco/reflow.git']);

  const [repo] = await readTaskRepos(dir);
  assert.equal(repo?.name, 'reflow-orders-drop-b2b-flag');
  assert.equal(repo?.repo, 'bigbluedisco/reflow');
});

test('a worktree with no remote reports no repo rather than an invented one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-repo-name-'));
  const worktree = join(dir, 'nowhere-in-particular');
  await mkdir(worktree, { recursive: true });
  await run('git', ['-C', worktree, 'init', '-q']);

  const [repo] = await readTaskRepos(dir);
  assert.equal(repo?.name, 'nowhere-in-particular');
  assert.equal(repo?.repo, undefined);
});

test('a linked worktree names its owning checkout without a remote or a matching name', async () => {
  // The case that made every fleetwood task unarchivable: the directory is named
  // `<repo>-<branch>` so the index cannot match it, and the repo has no remote to
  // fall back to. Neither name-based route can answer; git can.
  const root = await mkdtemp(join(tmpdir(), 'fw-owner-'));
  const checkout = join(root, 'fleetwood');
  await mkdir(checkout, { recursive: true });
  await run('git', ['-C', checkout, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'root']);
  assert.equal(await remoteNameWithOwner(checkout), undefined, 'fixture must have no remote');

  const linked = join(root, 'fleetwood-fix-prs-status');
  await run('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'fix/prs-status', linked]);

  // realpath because macOS hands out /var paths that are really /private/var.
  assert.equal(await mainCheckoutFor(linked), await realpath(checkout));
  // And it holds for an ordinary checkout, which is its own owner.
  assert.equal(await mainCheckoutFor(checkout), await realpath(checkout));
});

test('a path git knows nothing about has no owning checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-owner-none-'));
  assert.equal(await mainCheckoutFor(join(dir, 'does-not-exist')), undefined);
});

test('a kept worktree says which one and why, and only offers force when force would help', async () => {
  // The report used to read `kept 1 worktree(s) with uncommitted work` for every
  // reason there is, including the ones force cannot clear.
  const root = await mkdtemp(join(tmpdir(), 'fw-remove-'));
  const checkout = join(root, 'repo');
  await mkdir(checkout, { recursive: true });
  await run('git', ['-C', checkout, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'root']);
  const linked = join(root, 'repo-work');
  await run('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'work', linked]);

  // Clean: it goes, and nothing is kept.
  const clean = await removeWorktree(checkout, linked, false);
  assert.equal(clean.ok, true);
  assert.equal(clean.dirty, undefined);

  // Dirty: refused, and flagged as the kind of refusal force answers.
  await run('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'work2', linked]);
  await writeFile(join(linked, 'scratch.txt'), 'unsaved\n', 'utf8');
  const dirty = await removeWorktree(checkout, linked, false);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.dirty, true);
  assert.match(dirty.detail, /uncommitted change/);
});

/** The three-layer stack, as `readTaskRepos` would report it. */
const STACK = [
  {
    name: 'reflow-orders-use-order-type',
    path: '/t/reflow-orders-use-order-type',
    repo: 'bigbluedisco/reflow',
    branch: 'feature/orders-use-order-type',
    dirty: 0,
  },
  {
    name: 'reflow-orders-dual-write-order-type',
    path: '/t/reflow-orders-dual-write-order-type',
    repo: 'bigbluedisco/reflow',
    branch: 'feature/orders-dual-write-order-type',
    dirty: 0,
  },
  { name: 'proto', path: '/t/proto', repo: 'bigbluedisco/proto', branch: 'feature/x', dirty: 0 },
];

test('a worktree is named by its directory, and a repo name that fits one worktree also works', () => {
  assert.equal(matchTaskRepo(STACK, 'proto').repo?.name, 'proto');
  // Case-insensitive, and the full owner/name too.
  assert.equal(matchTaskRepo(STACK, 'bigbluedisco/proto').repo?.name, 'proto');
  assert.equal(matchTaskRepo(STACK, 'PROTO').repo?.name, 'proto');
  assert.equal(
    matchTaskRepo(STACK, 'reflow-orders-use-order-type').repo?.name,
    'reflow-orders-use-order-type',
  );
  // A branch names a layer, which is the other way you think of one.
  assert.equal(
    matchTaskRepo(STACK, 'feature/orders-dual-write-order-type').repo?.name,
    'reflow-orders-dual-write-order-type',
  );
});

test('a repo name matching several worktrees is an error, not a guess', () => {
  // The whole reason removal is keyed by directory: `reflow` is two layers of a
  // stack, and picking either one deletes work nobody asked about.
  const { repo, candidates } = matchTaskRepo(STACK, 'reflow');
  assert.equal(repo, undefined);
  assert.deepEqual(candidates.map((r) => r.name), [
    'reflow-orders-use-order-type',
    'reflow-orders-dual-write-order-type',
  ]);
});

test('a name matching nothing reports nothing rather than the first worktree', () => {
  assert.deepEqual(matchTaskRepo(STACK, 'atlas'), { repo: undefined, candidates: [] });
});
