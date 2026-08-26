import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchToSlug,
  buildBranch,
  linkTaskSkills,
  renderBrief,
  readTaskNotes,
  readTaskRepos,
  slugify,
  writeNotesFile,
} from '../src/task.ts';

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
