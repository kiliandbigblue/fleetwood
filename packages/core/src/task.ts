import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadConfig } from './config.ts';
import { getIndex, resolveRepo } from './repoIndex.ts';
import type { LocalRepo } from './repoIndex.ts';
import {
  currentBranch,
  defaultBranch,
  dirtyCount,
  ensureWorktree,
  listWorktrees,
  removeWorktree,
} from './worktree.ts';
import { run } from './exec.ts';
import * as tmux from './tmux.ts';
import { focusSession, spawnAgent } from './actions.ts';
import type { ActionResult } from './actions.ts';
import type { AgentTool } from './types.ts';

/**
 * A unit of work that spans repos.
 *
 * The folder is the record: each involved repo is a real git worktree inside it, so
 * `readdir` answers "which repos are in this task" and git answers "on which
 * branch". Only the immutable description is written down, in `task.json`.
 */
export interface Task {
  slug: string;
  branch: string;
  dir: string;
  type: string;
  microservice: string;
  summary: string;
  goal?: string;
  createdAt: number;
  repos: TaskRepo[];
  /** tmux session working this task, when one exists. */
  session?: string;
  /** Your own running notes, from `NOTES.md`. Absent when you haven't written any. */
  notes?: string;
}

export interface TaskRepo {
  /** Directory name inside the task folder, which is also the local repo name. */
  name: string;
  /** Absolute path of the worktree. */
  path: string;
  /** The repo this worktree belongs to, e.g. bigbluedisco/proto. */
  repo?: string;
  branch?: string;
  dirty: number;
}

/** The immutable half of a task, stored beside its worktrees. */
interface TaskRecord {
  version: 1;
  slug: string;
  branch: string;
  type: string;
  microservice: string;
  summary: string;
  goal?: string;
  createdAt: number;
}

const RECORD_FILE = 'task.json';
const BRIEF_FILE = 'TASK.md';
/** Hand-written, never generated — see `readTaskNotes`. */
const NOTES_FILE = 'NOTES.md';

/** Git ref names forbid a lot; keep to lowercase kebab and nothing surprising. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Build the branch name from the convention `<type>/<microservice>-<summary>`.
 *
 * The microservice is a domain rather than a repo, which is exactly why the same
 * name is reused across every repo a change touches.
 */
export function buildBranch(type: string, microservice: string, summary: string): string {
  const kind = slugify(type) || 'feature';
  const rest = [slugify(microservice), slugify(summary)].filter((p) => p.length > 0).join('-');
  return `${kind}/${rest}`;
}

/** Task folder name: the branch without its type prefix. */
export function branchToSlug(branch: string): string {
  const withoutType = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch;
  return slugify(withoutType);
}

export async function taskRoot(): Promise<string> {
  return (await loadConfig()).taskRoot;
}

export async function taskDirFor(slug: string): Promise<string> {
  return join(await taskRoot(), slug);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve however the user named a repo to a local checkout.
 *
 * Accepts `owner/name` or the plain directory name, because on the command line
 * nobody types the owner.
 */
export async function resolveRepoInput(name: string): Promise<LocalRepo | undefined> {
  if (name.includes('/')) {
    const byOwner = await resolveRepo(name);
    if (byOwner) return byOwner;
  }
  const wanted = basename(name).toLowerCase();
  const index = await getIndex();
  return (
    index.repos.find((r) => basename(r.path).toLowerCase() === wanted) ??
    index.repos.find((r) => r.nameWithOwner?.toLowerCase().endsWith(`/${wanted}`))
  );
}

/** Expand a name that might be a saved group into its repo list. */
export async function expandRepoGroups(names: string[]): Promise<string[]> {
  const { repoGroups } = await loadConfig();
  const out: string[] = [];
  for (const name of names) {
    const group = repoGroups[name];
    if (group) out.push(...group);
    else out.push(name);
  }
  return [...new Set(out)];
}

function renderBrief(record: TaskRecord, repos: TaskRepo[]): string {
  const lines = [
    `# ${record.summary || record.slug}`,
    '',
    `**Branch** \`${record.branch}\``,
    `**Microservice** ${record.microservice || '—'}`,
    '',
  ];
  if (record.goal) lines.push(record.goal, '');
  lines.push('## Repos in this task', '');
  for (const repo of repos) {
    lines.push(`- \`${repo.name}/\` — ${repo.repo ?? 'local'} on \`${repo.branch ?? record.branch}\``);
  }
  lines.push(
    '',
    '## Notes for agents',
    '',
    'Each directory here is a git worktree of a different repository, checked out on',
    'this task\'s branch. Edit across them freely; commit in each repo separately.',
    '',
    'Working from this folder does **not** load each repo\'s own `CLAUDE.md` /',
    '`AGENTS.md` or its `.claude/settings.local.json`. Read those when you start',
    'working inside a repo — they carry that repo\'s conventions.',
    '',
    'Beside this file, `NOTES.md` — when it exists — holds the human\'s own running',
    'notes on this task. Read it. `TASK.md`, the file you are reading, is generated',
    'and rewritten whenever a repo joins the task, so write nothing into it.',
    '',
  );
  return lines.join('\n');
}

async function readRecord(dir: string): Promise<TaskRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, RECORD_FILE), 'utf8')) as TaskRecord;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read the repos out of a task folder: the subdirectories, enriched from git. */
export async function readTaskRepos(dir: string): Promise<TaskRepo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const index = await getIndex();
  const repos: TaskRepo[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || entry === RECORD_FILE || entry === BRIEF_FILE || entry === NOTES_FILE)
      continue;
    const path = join(dir, entry);
    if (!(await exists(join(path, '.git')))) continue;
    const match = index.repos.find((r) => basename(r.path).toLowerCase() === entry.toLowerCase());
    repos.push({
      name: entry,
      path,
      repo: match?.nameWithOwner,
      branch: await currentBranch(path),
      dirty: await dirtyCount(path),
    });
  }
  return repos;
}

async function writeMeta(dir: string, record: TaskRecord, repos: TaskRepo[]): Promise<void> {
  await writeFile(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, BRIEF_FILE), renderBrief(record, repos), 'utf8');
}

/**
 * Your own notes on a task, from `NOTES.md`.
 *
 * A file of its own, and deliberately not part of `task.json` or `TASK.md`: the
 * record is immutable and the brief is regenerated on every repo change, so
 * anything you typed into either would eventually be overwritten. Keeping the
 * notes beside the worktrees rather than in `~/.fleetwood` also means an agent
 * working the task can read them without being told where to look — which is
 * most of the reason to write them down at all.
 */
export async function readTaskNotes(dir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, NOTES_FILE), 'utf8');
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replace a task's notes, by folder.
 *
 * Emptying them removes the file rather than leaving a blank one behind, so
 * "no notes" is one state on disk instead of two.
 */
export async function writeNotesFile(dir: string, notes: string): Promise<void> {
  const path = join(dir, NOTES_FILE);
  const text = notes.trim();
  if (text.length === 0) await rm(path, { force: true });
  else await writeFile(path, `${text}\n`, 'utf8');
}

/** Same, by slug — refuses a slug that is not a task rather than creating a folder. */
export async function writeTaskNotes(slug: string, notes: string): Promise<ActionResult> {
  const dir = await taskDirFor(slug);
  if (!(await readRecord(dir))) return { ok: false, detail: `no task named ${slug}` };

  await writeNotesFile(dir, notes);
  const length = notes.trim().length;
  return {
    ok: true,
    detail: length === 0 ? `cleared notes on ${slug}` : `saved notes on ${slug} (${length} chars)`,
  };
}

export interface CreateTaskInput {
  type: string;
  microservice: string;
  summary: string;
  goal?: string;
  /** Repo names or saved group names; branch overrides keyed by repo name. */
  repos: string[];
  branchOverrides?: Record<string, string>;
  /**
   * Agent to start at the task root. Defaults to `'none'`.
   *
   * Creating a task and choosing what runs in it are two decisions, and only the
   * first one is being made at that moment: the repo set is still a guess, and a
   * task often exists for a while before anyone works it. So the session is made
   * ready — right directory, right branch, stamped — and left at a shell. Ask for
   * an agent explicitly, here or with `+ claude` / `+ cursor` on the card.
   */
  agent?: AgentTool | 'none';
  background?: boolean;
}

export interface TaskResult {
  ok: boolean;
  task?: Task;
  detail: string;
  /** Per-repo outcomes, so a partial success is legible rather than silent. */
  repoResults: Array<{ repo: string; ok: boolean; detail: string }>;
}

/**
 * Create (or top up) a task: worktrees, brief, tmux session, agent.
 *
 * Idempotent by slug — running it twice adds any missing repos and focuses the
 * session rather than making a second one, the same contract as opening a PR.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskResult> {
  const branch = buildBranch(input.type, input.microservice, input.summary);
  const slug = branchToSlug(branch);
  const dir = await taskDirFor(slug);
  const repoResults: TaskResult['repoResults'] = [];

  const names = await expandRepoGroups(input.repos);
  if (names.length === 0) {
    return { ok: false, detail: 'a task needs at least one repo', repoResults };
  }

  await mkdir(dir, { recursive: true });

  const record: TaskRecord =
    (await readRecord(dir)) ??
    ({
      version: 1,
      slug,
      branch,
      type: slugify(input.type) || 'feature',
      microservice: input.microservice,
      summary: input.summary,
      goal: input.goal,
      createdAt: Math.floor(Date.now() / 1000),
    } satisfies TaskRecord);

  for (const name of names) {
    const local = await resolveRepoInput(name);
    if (!local) {
      repoResults.push({ repo: name, ok: false, detail: 'not found under your project roots' });
      continue;
    }
    if (!local.isRepo) {
      repoResults.push({ repo: name, ok: false, detail: 'not a git repository' });
      continue;
    }
    const target = join(dir, basename(local.path));
    const result = await ensureWorktree(local.path, input.branchOverrides?.[name] ?? record.branch, target);
    repoResults.push({ repo: basename(local.path), ok: result.ok, detail: result.detail });
  }

  const repos = await readTaskRepos(dir);
  if (repos.length === 0) {
    // Nothing was created, so leave no empty folder behind.
    await rm(dir, { recursive: true, force: true });
    return { ok: false, detail: 'no worktree could be created', repoResults };
  }

  await writeMeta(dir, record, repos);

  const session = await ensureTaskSession(record, dir, repos, input.agent ?? 'none');
  if (!input.background && session) await focusSession(session);

  return {
    ok: true,
    task: { ...record, dir, repos, session },
    detail: `task ${slug} on ${record.branch} with ${repos.length} repo${repos.length === 1 ? '' : 's'}`,
    repoResults,
  };
}

/**
 * One session per task, rooted at the task folder.
 *
 * The first window sits in the folder holding every worktree, which is the whole
 * point: whatever runs there can grep across repos and discover what the change
 * actually needs. It is left as a plain shell unless an agent was asked for —
 * see `CreateTaskInput.agent`.
 */
async function ensureTaskSession(
  record: TaskRecord,
  dir: string,
  repos: TaskRepo[],
  agent: AgentTool | 'none',
): Promise<string | undefined> {
  const sessions = await tmux.listSessions();
  const mine = sessions.find((s) => s.meta.task === record.slug);
  if (mine) return mine.name;

  // Avoid colliding with an unrelated session that happens to share the name.
  let name = record.slug;
  if (sessions.some((s) => s.name === name)) name = `${record.slug}-task`;
  if (sessions.some((s) => s.name === name)) return undefined;

  const created = await tmux.newSession({ name, cwd: dir, windowName: 'task' });
  if (!created) return undefined;

  await tmux.setSessionMeta(name, {
    kind: 'task',
    task: record.slug,
    branch: record.branch,
    taskdir: dir,
    repo: repos.map((r) => r.repo ?? r.name).join(','),
  });

  if (agent !== 'none') {
    await spawnAgent({ session: name, tool: agent, cwd: dir, windowName: 'task', reuseWindow: true });
  }
  return name;
}

/** Add a repo to a task that already exists — the answer to "I need proto too". */
export async function addRepoToTask(
  slug: string,
  repoName: string,
  branchOverride?: string,
): Promise<TaskResult> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return { ok: false, detail: `no task named ${slug}`, repoResults: [] };

  const local = await resolveRepoInput(repoName);
  if (!local?.isRepo) {
    return { ok: false, detail: `${repoName} is not a git repo under your project roots`, repoResults: [] };
  }

  const target = join(dir, basename(local.path));
  const result = await ensureWorktree(local.path, branchOverride ?? record.branch, target);
  const repos = await readTaskRepos(dir);
  await writeMeta(dir, record, repos);

  const sessions = await tmux.listSessions();
  const session = sessions.find((s) => s.meta.task === slug)?.name;
  if (session) {
    // Keep the stamped repo list honest, and give the repo a shell of its own.
    await tmux.setSessionMeta(session, { repo: repos.map((r) => r.repo ?? r.name).join(',') });
    await tmux.newWindow(session, { cwd: target, name: basename(local.path) });
  }

  return {
    ok: result.ok,
    task: { ...record, dir, repos, session },
    detail: result.detail,
    repoResults: [{ repo: basename(local.path), ok: result.ok, detail: result.detail }],
  };
}

export async function getTask(slug: string): Promise<Task | undefined> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return undefined;
  const sessions = await tmux.listSessions();
  return {
    ...record,
    dir,
    repos: await readTaskRepos(dir),
    session: sessions.find((s) => s.meta.task === slug)?.name,
    notes: await readTaskNotes(dir),
  };
}

/** Every task on disk, newest first, with its live session if it has one. */
export async function listTasks(): Promise<Task[]> {
  const root = await taskRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const sessions = await tmux.listSessions();
  const tasks: Task[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const dir = join(root, entry);
    const record = await readRecord(dir);
    if (!record) continue;
    tasks.push({
      ...record,
      dir,
      repos: await readTaskRepos(dir),
      session: sessions.find((s) => s.meta.task === record.slug)?.name,
      notes: await readTaskNotes(dir),
    });
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a task branch that never got used.
 *
 * Creating a worktree per repo means creating a branch per repo, and most tasks
 * end up touching fewer repos than they started with — without this, every task
 * leaves a trail of empty branches behind. Deliberately conservative: any commit
 * or any pushed ref means the branch stays.
 */
export async function pruneEmptyBranch(repoPath: string, branch: string): Promise<boolean> {
  // Pushed anywhere? Then it isn't ours to delete.
  const upstream = await run('git', [
    '-C',
    repoPath,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  if (upstream.code === 0) return false;

  const base = await defaultBranch(repoPath);
  // Compare against the *remote* base, which is what the branch was created from.
  // A local `master` can be far behind — proto's was 45 commits stale, which made
  // a brand-new empty branch look like it had 45 commits of its own.
  const remoteBase = `refs/remotes/origin/${base}`;
  const start =
    (await run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', remoteBase])).code === 0
      ? `origin/${base}`
      : base;

  const ahead = await run('git', ['-C', repoPath, 'rev-list', '--count', `${start}..${branch}`]);
  // Unparseable count means "don't touch it".
  const commits = Number.parseInt(ahead.stdout.trim(), 10);
  if (ahead.code !== 0 || !Number.isFinite(commits) || commits > 0) return false;

  const { code } = await run('git', ['-C', repoPath, 'branch', '-D', branch]);
  return code === 0;
}

export interface ArchiveResult {
  ok: boolean;
  detail: string;
  removed: string[];
  kept: string[];
}

/**
 * Tear a task down: every worktree, the folder, the session.
 *
 * Refuses per repo when a worktree has uncommitted work, and only removes the rest
 * — losing an agent's unpushed changes is unrecoverable, so `force` has to be a
 * deliberate choice.
 */
export async function archiveTask(slug: string, force = false): Promise<ArchiveResult> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return { ok: false, detail: `no task named ${slug}`, removed: [], kept: [] };

  const repos = await readTaskRepos(dir);
  const removed: string[] = [];
  const kept: string[] = [];

  for (const repo of repos) {
    const local = await resolveRepoInput(repo.repo ?? repo.name);
    if (!local) {
      kept.push(`${repo.name} (owning repo not found)`);
      continue;
    }
    const branch = repo.branch;
    const result = await removeWorktree(local.path, repo.path, force);
    if (!result.ok) {
      kept.push(`${repo.name} — ${result.detail}`);
      continue;
    }
    removed.push(repo.name);
    // Delete the branch only when it holds nothing: no commits of its own and
    // never pushed. Otherwise leave it — an abandoned branch is untidy, a deleted
    // one with work in it is unrecoverable.
    if (branch) await pruneEmptyBranch(local.path, branch);
  }

  if (kept.length > 0) {
    return {
      ok: false,
      detail: `kept ${kept.length} worktree(s) with uncommitted work; pass force to discard`,
      removed,
      kept,
    };
  }

  // Only now is the folder disposable: nothing but our own two files is left.
  await rm(dir, { recursive: true, force: true });

  const sessions = await tmux.listSessions();
  const session = sessions.find((s) => s.meta.task === slug);
  if (session) await tmux.killSession(session.name);

  return {
    ok: true,
    detail: `archived ${slug}: removed ${removed.length} worktree(s)${session ? ` and session ${session.name}` : ''}`,
    removed,
    kept,
  };
}

/** Local repos that are plausible next additions, most recently touched first. */
export async function suggestRepos(limit = 12): Promise<LocalRepo[]> {
  const index = await getIndex();
  const scored: Array<{ repo: LocalRepo; at: number }> = [];
  for (const repo of index.repos) {
    if (!repo.isRepo) continue;
    const branch = await currentBranch(repo.path);
    const worktrees = await listWorktrees(repo.path);
    // Recent local activity is a better signal than alphabetical order; a repo with
    // extra worktrees is one you are actively working in.
    scored.push({ repo, at: worktrees.length * 1_000 + (branch ? 1 : 0) });
  }
  return scored
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((s) => s.repo);
}
