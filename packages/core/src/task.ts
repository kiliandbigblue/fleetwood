import { mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  mainCheckoutFor,
  removeWorktree,
  remoteNameWithOwner,
} from './worktree.ts';
import type { EnsureWorktreeResult } from './worktree.ts';
import { branchToSlug, buildBranch, slugify, worktreeDirName } from './naming.ts';
import { sameSession } from './sessionOrder.ts';
import { recordArchive } from './taskHistory.ts';
import type { TaskPr } from './taskPrs.ts';
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
  /**
   * Directory name inside the task folder — `<repo>-<branch slug>`.
   *
   * Not the repo's name: a task can hold several worktrees of one repo, which is
   * what a stack is. Older tasks have directories named after the repo alone and
   * keep them; nothing is renamed. See `worktreeDirName`.
   */
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

/**
 * Where skills live, for both agents at once.
 *
 * The same two paths do double duty: they are where a repo keeps its skills, and
 * where an agent launched in the task folder looks for them — Claude Code reads
 * `.claude/skills`, Cursor reads `.agents/skills`. `.agents` leads because in a
 * repo that follows the convention it holds the real skill and `.claude/skills`
 * only symlinks to it, so reading it first means the canonical copy is the one
 * that gets linked.
 */
const SKILL_TREES = ['.agents/skills', '.claude/skills'] as const;

// The naming rules live in a leaf module so the renderer can use the real ones
// rather than a copy. Re-exported here because this is where callers look.
export { branchToSlug, buildBranch, slugify, worktreeDirName } from './naming.ts';

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

/** The agent-facing brief. Exported for its tests; `writeMeta` is the only caller. */
export function renderBrief(record: TaskRecord, repos: TaskRepo[], skills: string[] = []): string {
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
    'Each directory here is a git worktree, named `<repo>-<branch>`. Usually that is',
    'one repository each on this task\'s branch — but when the work is stacked it is',
    'the same repository on several branches, one per layer. The list above says',
    'which is which. Edit across them freely; commit in each worktree separately.',
    '',
    'Working from this folder does **not** load each repo\'s own `CLAUDE.md` /',
    '`AGENTS.md` or its `.claude/settings.local.json`. Read those when you start',
    'working inside a repo — they carry that repo\'s conventions. Skills are the',
    'one exception: they are linked in here for you.',
    '',
    'Beside this file, `NOTES.md` — when it exists — holds the human\'s own running',
    'notes on this task. Read it. `TASK.md`, the file you are reading, is generated',
    'and rewritten whenever a repo joins the task, so write nothing into it.',
    '',
  );
  if (skills.length > 0) {
    lines.push(
      '## Skills from these repos',
      '',
      'Linked into `.claude/skills` and `.agents/skills` beside this file, so they',
      'are invokable from here by name:',
      '',
      ...skills.map((name) => `- \`/${name}\``),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * Put a worktree for `branch` inside a task folder.
 *
 * Adoption first: any worktree of this repo already sitting inside the task
 * folder on that branch *is* the one, whatever its directory is called. That is
 * what keeps the naming change from touching tasks that already exist — a folder
 * with `graphy/` in it stays a folder with `graphy/` in it, and re-running
 * `createTask` on it tops up rather than building a second checkout beside the
 * first. New worktrees get `<repo>-<branch slug>`.
 */
async function ensureTaskWorktree(
  localPath: string,
  repoName: string,
  branch: string,
  taskDir: string,
): Promise<EnsureWorktreeResult> {
  const adopted = (await listWorktrees(localPath)).find(
    (w) => w.branch === branch && (w.path === taskDir || w.path.startsWith(`${taskDir}/`)),
  );
  if (adopted) {
    return {
      ok: true,
      path: adopted.path,
      branch,
      created: false,
      detail: `reusing worktree at ${basename(adopted.path)}`,
    };
  }
  return ensureWorktree(localPath, branch, join(taskDir, worktreeDirName(repoName, branch)));
}

/**
 * The session working a task, self-healing tmux metadata a restore tool
 * (tmux-resurrect) recreated without it.
 *
 * A session tmux-resurrect rebuilds keeps its name and cwd but not our
 * `@fw_*` user options — nothing in its hook set runs after a restore to put
 * them back. So a session that matches this task by name or path but has no
 * `@fw_task` is claimed and stamped here, exactly as a brand-new one is in
 * {@link ensureTaskSession}.
 */
async function resolveTaskSession(
  sessions: tmux.SessionRow[],
  record: Pick<TaskRecord, 'slug' | 'branch'>,
  dir: string,
  repos: TaskRepo[],
): Promise<tmux.SessionRow | undefined> {
  const found = tmux.findTaskSession(sessions, record.slug, dir);
  if (!found) return undefined;
  if (found.adopted) {
    await tmux.setSessionMeta(found.session.name, {
      kind: 'task',
      task: record.slug,
      branch: record.branch,
      taskdir: dir,
      repo: repos.map((r) => r.repo ?? r.name).join(','),
    });
  }
  return found.session;
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
      /*
       * The index first, then the worktree's own remote.
       *
       * Matching the directory name against the index is right for the ordinary
       * layout, where a task's worktree is named after its repo. It is wrong for
       * stacked work, where the convention is one directory per branch —
       * `reflow-orders-drop-b2b-flag` — and none of them is called `reflow`. That
       * left `repo` unknown, and `archiveTask` resolves the owning checkout
       * through it: every worktree in a stacked task was kept with "owning repo
       * not found", which is a task that cannot be archived at all.
       */
      repo: match?.nameWithOwner ?? (await remoteNameWithOwner(path)),
      branch: await currentBranch(path),
      dirty: await dirtyCount(path),
    });
  }
  return repos;
}

/**
 * Link every repo's skills into the task folder, for both agents.
 *
 * An agent launched here treats the task folder as its project root, so the only
 * skills it loads are the global ones and whatever sits in this folder's own
 * `.claude/skills` / `.agents/skills`. Every repo's skills are one level down
 * inside a worktree, which is nowhere either agent looks — so `relaunch-app`,
 * defined in `fleetwood/.claude/skills`, is invisible from the task that
 * contains fleetwood. These links are what make it `/relaunch-app` again.
 *
 * Rewritten whenever the brief is, which is what keeps it honest: a repo that
 * left the task takes its skills with it on the next write. Only symlinks are
 * cleared — a real directory in there is someone's own skill, and not ours to
 * remove.
 *
 * Returns the names it linked, in order, for the brief to list.
 */
export async function linkTaskSkills(dir: string, repos: TaskRepo[]): Promise<string[]> {
  const roots = SKILL_TREES.map((tree) => join(dir, tree));
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) await rm(join(root, entry.name), { force: true });
    }
  }

  const linked: string[] = [];
  const claimed = new Set<string>();
  const sources = new Set<string>();

  for (const repo of repos) {
    for (const tree of SKILL_TREES) {
      let entries: string[];
      try {
        entries = await readdir(join(repo.path, tree));
      } catch {
        continue;
      }

      for (const name of entries.sort()) {
        const source = join(repo.path, tree, name);
        if (!(await exists(join(source, 'SKILL.md')))) continue;

        // The same skill reached through both trees, which is what a repo
        // following the convention looks like: one skill, linked once.
        const real = await realpath(source);
        if (sources.has(real)) continue;

        // `name:` in the frontmatter has to match the folder it lives in, so a
        // second repo's same-named skill cannot be renamed out of the way here.
        // First repo in the task wins; the other stays reachable at its path.
        if (claimed.has(name)) continue;

        claimed.add(name);
        sources.add(real);
        linked.push(name);

        // Relative, so moving the task folder does not break them.
        const rel = join('..', '..', repo.name, tree, name);
        // A real directory already holding that name is left as it is.
        for (const root of roots) await symlink(rel, join(root, name)).catch(() => undefined);
      }
    }
  }
  return linked;
}

async function writeMeta(dir: string, record: TaskRecord, repos: TaskRepo[]): Promise<void> {
  await writeFile(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const skills = await linkTaskSkills(dir, repos);
  await writeFile(join(dir, BRIEF_FILE), renderBrief(record, repos, skills), 'utf8');
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
    const result = await ensureTaskWorktree(
      local.path,
      basename(local.path),
      input.branchOverrides?.[name] ?? record.branch,
      dir,
    );
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
  const mine = await resolveTaskSession(sessions, record, dir, repos);
  if (mine) return mine.name;

  // Avoid colliding with an unrelated session that happens to share the name —
  // by label, since one of them may be carrying an order prefix.
  let name = record.slug;
  if (sessions.some((s) => sameSession(s.name, name))) name = `${record.slug}-task`;
  if (sessions.some((s) => sameSession(s.name, name))) return undefined;

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

/**
 * Give an existing task the tmux session it hasn't got yet.
 *
 * A task is a folder of worktrees, and creating one deliberately starts nothing —
 * so a task can sit on disk for days with no session. That state used to be a dead
 * end in the panel: every button on the card needed a session name it didn't have.
 * This is the way out of it, and the same call whether you want a bare shell or an
 * agent, because `ensureTaskSession` already decides both and is idempotent by
 * slug: if something already made the session, it is returned rather than doubled.
 */
export async function startTaskSession(
  slug: string,
  agent: AgentTool | 'none' = 'none',
): Promise<TaskResult> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return { ok: false, detail: `no task named ${slug}`, repoResults: [] };

  const repos = await readTaskRepos(dir);
  /*
   * Look for the session before asking for one, because `ensureTaskSession` starts
   * the agent only on a session it *created* — its caller is task creation, where
   * finding one already there means somebody else set the task up and dropping an
   * agent into it would be a surprise.
   *
   * Here the ask is the other way round: `--agent claude` said start claude, and a
   * session that already exists is not a reason to have started nothing. It is
   * also a live race — the panel decides which button to draw from a snapshot up
   * to a second old, so a task can gain a session between the draw and the click.
   * Either way the agent is spawned, exactly as `+ claude` on a live card would.
   */
  const existing = await resolveTaskSession(await tmux.listSessions(), record, dir, repos);
  const session = existing?.name ?? (await ensureTaskSession(record, dir, repos, agent));
  if (!session) {
    return { ok: false, detail: `could not create a tmux session for ${slug}`, repoResults: [] };
  }

  let spawned: ActionResult | undefined;
  if (existing && agent !== 'none') spawned = await spawnAgent({ session, tool: agent, cwd: dir });
  await focusSession(session);

  const what = existing ? `session ${session} already existed` : `session ${session}`;
  return {
    // A session we could not put the agent into is a partial success, and saying
    // so is the difference between "it's running" and "go and look".
    ok: spawned?.ok ?? true,
    task: { ...record, dir, repos, session, notes: await readTaskNotes(dir) },
    detail:
      agent === 'none'
        ? what
        : spawned
          ? `${what} — ${spawned.detail}`
          : `${what} running ${agent}`,
    repoResults: [],
  };
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

  const result = await ensureTaskWorktree(
    local.path,
    basename(local.path),
    branchOverride ?? record.branch,
    dir,
  );
  const repos = await readTaskRepos(dir);
  await writeMeta(dir, record, repos);

  const sessions = await tmux.listSessions();
  const session = (await resolveTaskSession(sessions, record, dir, repos))?.name;
  // Only for a worktree that exists: a failed add used to open a window on a
  // directory git had just refused to create.
  if (session && result.ok && result.path) {
    // Keep the stamped repo list honest, and give the worktree a shell of its own.
    await tmux.setSessionMeta(session, { repo: repos.map((r) => r.repo ?? r.name).join(',') });
    // Named for the directory, not the repo: a stacked task holds several
    // worktrees of one repo, and two windows called `reflow` say nothing.
    await tmux.newWindow(session, { cwd: result.path, name: basename(result.path) });
  }

  return {
    ok: result.ok,
    task: { ...record, dir, repos, session },
    detail: result.detail,
    repoResults: [{ repo: basename(local.path), ok: result.ok, detail: result.detail }],
  };
}

/**
 * Which worktree `fw task rm reflow` means.
 *
 * Pure, and deliberately fussy about ambiguity: the directory name is the only
 * unique handle a task has — a stack holds three worktrees whose `repo` is all
 * `bigbluedisco/reflow`, so "reflow" cannot be allowed to pick one of them at
 * random. Exact directory name first, then the repo it belongs to, and a repo
 * that matches more than one worktree is an error rather than a guess.
 */
export function matchTaskRepo(
  repos: TaskRepo[],
  name: string,
): { repo?: TaskRepo; candidates: TaskRepo[] } {
  const wanted = name.trim().toLowerCase();
  const exact = repos.find((r) => r.name.toLowerCase() === wanted);
  if (exact) return { repo: exact, candidates: [exact] };

  // `reflow` for `bigbluedisco/reflow`, and the full `owner/name` too.
  const byRepo = repos.filter((r) => {
    const repo = r.repo?.toLowerCase();
    return repo === wanted || repo?.split('/')[1] === wanted;
  });
  // A branch also names a layer, which is the other way you think of one.
  const byBranch = repos.filter((r) => r.branch?.toLowerCase() === wanted);
  const candidates = byRepo.length > 0 ? byRepo : byBranch;
  return { repo: candidates.length === 1 ? candidates[0] : undefined, candidates };
}

/**
 * Drop one worktree from a task — the answer to "that PR landed, this is done".
 *
 * The inverse of `addRepoToTask`, and `archiveTask` for a single repo: same
 * refusal on uncommitted work, same conservative branch prune, and the brief and
 * skill links are rewritten so the task stops advertising a repo it no longer
 * holds. The task folder itself always stays, even when this empties it —
 * removing the last worktree is not the same decision as archiving the task, and
 * `task.json` is the record of work that happened.
 */
export async function removeRepoFromTask(
  slug: string,
  repoName: string,
  force = false,
): Promise<TaskResult> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return { ok: false, detail: `no task named ${slug}`, repoResults: [] };

  const before = await readTaskRepos(dir);
  const { repo, candidates } = matchTaskRepo(before, repoName);
  if (!repo) {
    const detail =
      candidates.length > 1
        ? `${repoName} matches ${candidates.length} worktrees in ${slug}: ${candidates
            .map((r) => r.name)
            .join(', ')} — name one`
        : `no worktree ${repoName} in ${slug}${
            before.length > 0 ? ` (has ${before.map((r) => r.name).join(', ')})` : ''
          }`;
    return { ok: false, task: { ...record, dir, repos: before }, detail, repoResults: [] };
  }

  // Git first, exactly as archive does: the worktree knows which checkout owns
  // it, and the name-based routes each have a case they cannot answer.
  const owner = (await mainCheckoutFor(repo.path)) ?? (await resolveRepoInput(repo.repo ?? repo.name))?.path;
  if (!owner) {
    return {
      ok: false,
      task: { ...record, dir, repos: before },
      detail: `${repo.name} — owning checkout not found`,
      repoResults: [{ repo: repo.name, ok: false, detail: 'owning checkout not found' }],
    };
  }

  const result = await removeWorktree(owner, repo.path, force);
  if (!result.ok) {
    return {
      ok: false,
      task: { ...record, dir, repos: before },
      detail: `${repo.name} — ${result.detail}${result.dirty ? '; pass force to discard' : ''}`,
      repoResults: [{ repo: repo.name, ok: false, detail: result.detail }],
    };
  }

  // Same rule as archive: no commits of its own and never pushed. A landed
  // branch is a pushed one, so it stays — untidy beats unrecoverable.
  const pruned = repo.branch ? await pruneEmptyBranch(owner, repo.branch) : false;

  // The brief and the skill links both name the repos, so they have to be
  // rewritten here — otherwise the task keeps telling agents to go and read a
  // directory that is gone.
  const repos = await readTaskRepos(dir);
  await writeMeta(dir, record, repos);

  const sessions = await tmux.listSessions();
  const session = (await resolveTaskSession(sessions, record, dir, repos))?.name;
  let windows = 0;
  if (session) {
    await tmux.setSessionMeta(session, { repo: repos.map((r) => r.repo ?? r.name).join(',') });
    // A window whose cwd has just been deleted is a shell that cannot run
    // anything, so it goes with the worktree. The task window sits on the task
    // root, above every worktree, so it is never one of these.
    for (const id of tmux.windowsUnderPath(await tmux.listPanes(), session, repo.path)) {
      if (await tmux.killWindow(id)) windows += 1;
    }
  }

  const notes = [
    pruned ? `pruned ${repo.branch}` : undefined,
    windows > 0 ? `closed ${windows} window(s)` : undefined,
    repos.length === 0 ? `${slug} now holds no worktrees — \`fw task archive ${slug}\`` : undefined,
  ].filter((n) => n !== undefined);

  return {
    ok: true,
    task: { ...record, dir, repos, session, notes: await readTaskNotes(dir) },
    detail: `removed ${repo.name} from ${slug}${notes.length > 0 ? ` — ${notes.join(', ')}` : ''}`,
    repoResults: [{ repo: repo.name, ok: true, detail: result.detail }],
  };
}

export async function getTask(slug: string): Promise<Task | undefined> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return undefined;
  const [sessions, repos] = await Promise.all([tmux.listSessions(), readTaskRepos(dir)]);
  return {
    ...record,
    dir,
    repos,
    session: (await resolveTaskSession(sessions, record, dir, repos))?.name,
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
    const repos = await readTaskRepos(dir);
    tasks.push({
      ...record,
      dir,
      repos,
      session: (await resolveTaskSession(sessions, record, dir, repos))?.name,
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

export interface ArchiveTaskOptions {
  /**
   * The task's pull requests, for the history record.
   *
   * Passed in rather than fetched because the caller usually has them already —
   * the app keeps them in its snapshot — and because `discoverTaskBranches` only
   * works while the worktrees exist, which is the very thing this function is
   * about to undo. Omitted, the record keeps the branches and no PRs; archiving
   * does not make a network call to fill them in.
   */
  prs?: TaskPr[];
}

/**
 * Tear a task down: every worktree, the folder, the session.
 *
 * Refuses per repo when a worktree has uncommitted work, and only removes the rest
 * — losing an agent's unpushed changes is unrecoverable, so `force` has to be a
 * deliberate choice.
 *
 * On the way out it writes the task to the history log, so the description and
 * where the work landed outlive the folder — see `taskHistory.ts`.
 */
export async function archiveTask(
  slug: string,
  force = false,
  options: ArchiveTaskOptions = {},
): Promise<ArchiveResult> {
  const dir = await taskDirFor(slug);
  const record = await readRecord(dir);
  if (!record) return { ok: false, detail: `no task named ${slug}`, removed: [], kept: [] };

  const repos = await readTaskRepos(dir);
  const removed: string[] = [];
  const kept: string[] = [];
  let anyDirty = false;

  for (const repo of repos) {
    // Git first: the worktree knows which checkout owns it, and the two name-based
    // routes each have a case they cannot answer — the index needs the directory
    // to be named after the repo, the remote needs there to be a remote.
    const owner = (await mainCheckoutFor(repo.path)) ?? (await resolveRepoInput(repo.repo ?? repo.name))?.path;
    if (!owner) {
      kept.push(`${repo.name} — owning checkout not found`);
      continue;
    }
    const branch = repo.branch;
    const result = await removeWorktree(owner, repo.path, force);
    if (!result.ok) {
      kept.push(`${repo.name} — ${result.detail}`);
      anyDirty ||= result.dirty === true;
      continue;
    }
    removed.push(repo.name);
    // Delete the branch only when it holds nothing: no commits of its own and
    // never pushed. Otherwise leave it — an abandoned branch is untidy, a deleted
    // one with work in it is unrecoverable.
    if (branch) await pruneEmptyBranch(owner, branch);
  }

  if (kept.length > 0) {
    // Say which worktree and why. This used to report every keep as uncommitted
    // work whatever the reason, which sent you looking for changes that were not
    // there — and hid the one cause `force` cannot clear. The hint goes with the
    // refusal it actually answers, rather than on every failure.
    return {
      ok: false,
      detail: `kept ${kept.length} worktree(s): ${kept.join('; ')}${anyDirty ? '; pass force to discard' : ''}`,
      removed,
      kept,
    };
  }

  /*
   * The last moment the task still exists anywhere.
   *
   * After the `rm` there is nothing left to read it from — and `repos` was read
   * at the top, while the worktrees were still there, so it carries the branches
   * that the pruning above may since have deleted. Best-effort by construction:
   * `recordArchive` swallows its own failures rather than block the teardown.
   */
  await recordArchive({ task: record, repos, prs: options.prs });

  // Only now is the folder disposable: nothing but our own two files is left.
  await rm(dir, { recursive: true, force: true });

  const sessions = await tmux.listSessions();
  const session = tmux.findTaskSession(sessions, slug, dir)?.session;
  // Move whatever is attached to the task's session onto another one before
  // killing it: a detached client drops its Ghostty window back to a bare shell.
  const kill = session ? await tmux.killSessionKeepingClients(session.name) : undefined;

  const sessionNote = session
    ? ` and session ${session.name}${kill?.switchedTo ? ` (focused ${kill.switchedTo})` : ''}`
    : '';
  return {
    ok: true,
    detail: `archived ${slug}: removed ${removed.length} worktree(s)${sessionNote}`,
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
