import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { run } from './exec.ts';
import { loadConfig } from './config.ts';
import { parseRemote } from './repoIndex.ts';

export interface Worktree {
  path: string;
  head?: string;
  /** Short branch name, absent when detached. */
  branch?: string;
  locked: boolean;
}

/** Parse `git worktree list --porcelain`, which is record-per-blank-line. */
export function parseWorktrees(stdout: string): Worktree[] {
  const out: Worktree[] = [];
  let current: Partial<Worktree> & { path?: string } = {};
  const flush = (): void => {
    if (current.path) out.push({ path: current.path, head: current.head, branch: current.branch, locked: current.locked ?? false });
    current = {};
  };
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') current.locked = true;
  }
  flush();
  return out;
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const { code, stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return code === 0 ? parseWorktrees(stdout) : [];
}

/** Filesystem-safe, readable, and stable for the same PR. */
export function worktreeSlug(prNumber: number, branch: string | undefined): string {
  const base = branch ? branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') : 'head';
  return `pr-${prNumber}-${base}`.slice(0, 80);
}

export async function worktreeRoot(repoPath: string): Promise<string> {
  const config = await loadConfig();
  return join(repoPath, config.worktreeDir);
}

/**
 * Keep fleetwood's worktrees out of `git status` without touching the repo's
 * tracked `.gitignore` — `.git/info/exclude` is local-only, so this never shows
 * up in a diff or a PR.
 */
export async function ensureExcluded(repoPath: string, entry = '.agents/'): Promise<void> {
  const excludeFile = join(repoPath, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludeFile, 'utf8');
  } catch {
    // A linked worktree or unusual layout: .git may be a file. Skip silently
    // rather than guessing where the real gitdir lives.
    try {
      await mkdir(join(repoPath, '.git', 'info'), { recursive: true });
    } catch {
      return;
    }
  }
  if (current.split('\n').some((l) => l.trim() === entry.trim())) return;
  const next = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current;
  try {
    await writeFile(excludeFile, `${next}${entry}\n`, 'utf8');
  } catch {
    // Non-fatal: worse case the worktree shows as untracked.
  }
}

export interface EnsureWorktreeResult {
  ok: boolean;
  path?: string;
  branch?: string;
  created: boolean;
  detail: string;
}

/**
 * The branch a new branch should start from.
 *
 * Never assume `main`: across these repos the default is `dev` (atlas, graphy,
 * reflow) or `master` (proto). `symbolic-ref` answers locally for a normal clone;
 * `ls-remote` is the network fallback for clones that never recorded origin/HEAD.
 */
export async function defaultBranch(repoPath: string): Promise<string> {
  const local = await run('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (local.code === 0) {
    const name = local.stdout.trim().replace(/^origin\//, '');
    if (name.length > 0) return name;
  }
  const remote = await run('git', ['-C', repoPath, 'ls-remote', '--symref', 'origin', 'HEAD'], {
    timeoutMs: 30_000,
  });
  const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout);
  return match?.[1] ?? 'main';
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const { code } = await run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref]);
  return code === 0;
}

/**
 * The repo's default branch as a remote-tracking ref, read locally and only locally.
 *
 * `defaultBranch` above falls back to `git ls-remote` when origin/HEAD is missing.
 * Callers on a poll — or behind a click, which has to answer now — cannot afford a
 * network round trip per worktree. No answer is returned as `undefined` rather than
 * as a guessed `main`, so each caller decides what to do without one.
 *
 * The `origin/` prefix is kept, unlike `defaultBranch`: a task worktree usually
 * holds only the task branch, so a local `dev` is often stale or missing outright
 * while `origin/dev` is current as of the last fetch.
 */
export async function localDefaultBranch(repoPath: string): Promise<string | undefined> {
  const { code, stdout } = await run('git', [
    '-C',
    repoPath,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (code !== 0) return undefined;
  const name = stdout.trim();
  return name.length > 0 ? name : undefined;
}

/**
 * Branches worth trying as a review base in a repo with no remote at all.
 *
 * Ordered by how strongly each names a trunk. Only reached when there is no
 * origin/HEAD to read — fleetwood's own worktrees are the case in hand — and every
 * candidate is checked for existence before it is used, so this stays a lookup
 * rather than the `main` assumption `defaultBranch` exists to avoid.
 */
const LOCAL_TRUNKS = ['main', 'master', 'dev', 'develop'];

/**
 * What a worktree's work should be reviewed against.
 *
 * origin/HEAD is the real answer wherever there is a remote, which is every cloned
 * repo. A repo that was never pushed anywhere has none, and refusing there would
 * make a review button useless in exactly the repos worked on locally — so the
 * local trunks are tried in turn, by existence.
 *
 * The branch the worktree is on is deliberately *not* excluded: sitting on the
 * trunk itself, "what have I changed against the trunk" is still the honest
 * question, and the answer is the uncommitted work.
 *
 * This is the answer for a branch cut straight from the trunk. A stacked layer's
 * base is the layer below it, which no read of the commit graph can recover — see
 * `resolveBaseRef`, and the pull request's `base` that feeds it.
 */
export async function reviewBase(repoPath: string): Promise<string | undefined> {
  const remote = await localDefaultBranch(repoPath);
  if (remote) return remote;
  for (const name of LOCAL_TRUNKS) {
    if (await refExists(repoPath, `refs/heads/${name}`)) return name;
  }
  return undefined;
}

/**
 * Turn a branch *name* into a ref this worktree can actually diff against.
 *
 * A pull request reports its base as a bare name — `dev`, or a sibling layer's
 * `fix/orders-helper-order-type-b2b`. Neither is necessarily usable as written: a
 * task worktree holds one branch and its local copy of any other may be stale or
 * absent entirely, and difit fails outright on a ref that does not resolve.
 *
 * The remote-tracking ref is preferred for the reason `localDefaultBranch` keeps
 * the `origin/` prefix — it is current as of the last fetch, where a local copy is
 * whatever it was when this worktree last saw it. Either answers the same question
 * anyway once `--merge-base` is applied: the fork point does not move when the base
 * branch advances past it.
 *
 * `undefined` means neither form exists here, and the caller should fall back
 * rather than hand difit a ref it will refuse.
 */
export async function resolveBaseRef(repoPath: string, branch: string): Promise<string | undefined> {
  const name = branch.trim().replace(/^origin\//, '');
  if (name.length === 0) return undefined;
  if (await refExists(repoPath, `refs/remotes/origin/${name}`)) return `origin/${name}`;
  if (await refExists(repoPath, `refs/heads/${name}`)) return name;
  return undefined;
}

export interface EnsureWorktreeOptions {
  /** Branch to start from when the branch has to be created. Defaults to origin's HEAD. */
  base?: string;
  /** Skip the fetch before branching. */
  offline?: boolean;
}

/**
 * Put a worktree for `branch` at exactly `targetDir`.
 *
 * Unlike the PR flow, task branches usually do not exist yet, so this creates
 * them from the repo's default branch. The location is caller-chosen because a
 * task groups worktrees from several repos under one directory — that grouping is
 * what lets a single agent see them all.
 */
export async function ensureWorktree(
  repoPath: string,
  branch: string,
  targetDir: string,
  options: EnsureWorktreeOptions = {},
): Promise<EnsureWorktreeResult> {
  const existing = await listWorktrees(repoPath);

  const here = existing.find((w) => w.path === targetDir);
  if (here) {
    // Reuse only what was actually asked for. This used to hand back whatever
    // branch happened to be there, reported as a success — so asking a task for a
    // second branch of a repo it already held returned the first branch's
    // worktree and created nothing, which is silence where an error belonged.
    if (here.branch !== undefined && here.branch !== branch) {
      return {
        ok: false,
        created: false,
        detail: `${targetDir} already holds ${here.branch}, not ${branch}`,
      };
    }
    return {
      ok: true,
      path: targetDir,
      branch: here.branch ?? branch,
      created: false,
      detail: `reusing worktree at ${targetDir}`,
    };
  }

  // git refuses to check one branch out twice, and moving someone else's worktree
  // would be rude — say where it is instead of failing cryptically.
  const elsewhere = existing.find((w) => w.branch === branch);
  if (elsewhere) {
    return {
      ok: false,
      created: false,
      detail: `${branch} is already checked out at ${elsewhere.path} — use a different branch for this repo`,
    };
  }

  await mkdir(dirname(targetDir), { recursive: true });

  const localExists = await refExists(repoPath, `refs/heads/${branch}`);
  let args: string[];

  if (localExists) {
    args = ['-C', repoPath, 'worktree', 'add', targetDir, branch];
  } else {
    if (!options.offline) {
      // Fetching the branch is cheap and makes "someone already pushed this" work.
      await run('git', ['-C', repoPath, 'fetch', 'origin', branch], { timeoutMs: 120_000 });
    }
    if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
      args = ['-C', repoPath, 'worktree', 'add', '--track', '-b', branch, targetDir, `origin/${branch}`];
    } else {
      const base = options.base ?? (await defaultBranch(repoPath));
      if (!options.offline) {
        await run('git', ['-C', repoPath, 'fetch', 'origin', base], { timeoutMs: 120_000 });
      }
      const start = (await refExists(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
      args = ['-C', repoPath, 'worktree', 'add', '-b', branch, targetDir, start];
    }
  }

  const { code, stderr } = await run('git', args, { timeoutMs: 120_000 });
  if (code !== 0) {
    return { ok: false, created: false, detail: `git worktree add failed: ${stderr.trim()}` };
  }
  return { ok: true, path: targetDir, branch, created: true, detail: `created worktree at ${targetDir}` };
}

/**
 * Get a worktree checked out at a PR's branch, creating it only if needed.
 *
 * Reuses an existing worktree for the branch when there is one, which is what
 * makes "open this PR" idempotent — and avoids git's refusal to check the same
 * branch out twice.
 */
export async function ensureWorktreeForPr(
  repoPath: string,
  prNumber: number,
  branch: string | undefined,
): Promise<EnsureWorktreeResult> {
  const existing = await listWorktrees(repoPath);

  if (branch) {
    const match = existing.find((w) => w.branch === branch);
    if (match) {
      return { ok: true, path: match.path, branch, created: false, detail: `reusing worktree at ${match.path}` };
    }
  }

  const slug = worktreeSlug(prNumber, branch);
  const target = join(await worktreeRoot(repoPath), slug);
  const alreadyThere = existing.find((w) => w.path === target);
  if (alreadyThere) {
    return {
      ok: true,
      path: target,
      branch: alreadyThere.branch ?? branch,
      created: false,
      detail: `reusing worktree at ${target}`,
    };
  }

  await ensureExcluded(repoPath);
  await mkdir(await worktreeRoot(repoPath), { recursive: true });

  // Fetch the branch from origin; fall back to the PR ref, which also covers
  // pull requests opened from forks.
  let localBranch = branch;
  let fetched = false;
  if (branch) {
    const { code } = await run('git', ['-C', repoPath, 'fetch', 'origin', branch], { timeoutMs: 120_000 });
    fetched = code === 0;
  }
  if (!fetched) {
    localBranch = `pr-${prNumber}`;
    const { code, stderr } = await run(
      'git',
      ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:refs/heads/${localBranch}`],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) {
      return { ok: false, created: false, detail: `could not fetch PR #${prNumber}: ${stderr.trim()}` };
    }
  }

  const branchExists =
    localBranch !== undefined &&
    (await run('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${localBranch}`])).code === 0;

  const args = branchExists
    ? ['-C', repoPath, 'worktree', 'add', target, localBranch as string]
    : ['-C', repoPath, 'worktree', 'add', '--track', '-b', localBranch as string, target, `origin/${localBranch}`];

  const { code, stderr } = await run('git', args, { timeoutMs: 120_000 });
  if (code !== 0) {
    return { ok: false, created: false, detail: `git worktree add failed: ${stderr.trim()}` };
  }

  return { ok: true, path: target, branch: localBranch, created: true, detail: `created worktree at ${target}` };
}

export interface RemoveResult {
  ok: boolean;
  detail: string;
  /** Whether the refusal was about uncommitted work — the one `force` clears. */
  dirty?: boolean;
}

/**
 * Remove a worktree, refusing when it holds uncommitted work unless forced.
 *
 * Deleting an agent's unpushed changes is unrecoverable, so `force` has to be an
 * explicit decision made upstream.
 */
export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<RemoveResult> {
  const { stdout: status } = await run('git', ['-C', worktreePath, 'status', '--porcelain']);
  const dirty = status.trim().length > 0;
  if (dirty && !force) {
    const files = status.trim().split('\n').length;
    return { ok: false, detail: `refusing: ${files} uncommitted change(s) in ${worktreePath}`, dirty: true };
  }

  const args = ['-C', repoPath, 'worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const { code, stderr } = await run('git', args, { timeoutMs: 60_000 });
  if (code !== 0) return { ok: false, detail: `git worktree remove failed: ${stderr.trim()}` };
  return { ok: true, detail: `removed ${worktreePath}${dirty ? ' (forced, discarded local changes)' : ''}` };
}

/** Uncommitted-change count for a working tree, for the dirty indicator. */
export async function dirtyCount(path: string): Promise<number> {
  const { code, stdout } = await run('git', ['-C', path, 'status', '--porcelain']);
  if (code !== 0) return 0;
  return stdout.trim().length === 0 ? 0 : stdout.trim().split('\n').length;
}

/**
 * The checkout a linked worktree belongs to — where its real `.git` lives.
 *
 * Asked of git rather than worked out from a name, because a name cannot always
 * answer it. `archiveTask` used to go through the repo *index*, keyed by
 * directory name, and then through the origin remote — and a task worktree has
 * neither to offer when it is named `<repo>-<branch>` for stacked work *and* its
 * repo has no remote. fleetwood itself is exactly that repo, so no fleetwood task
 * could be archived at all, not even with `--force`: the owning checkout is
 * resolved before force is ever consulted.
 *
 * `--git-common-dir` is the linked worktree's pointer back to the real one, which
 * is the fact being asked for, and it holds for an ordinary checkout too — there
 * it is that checkout's own `.git`.
 */
export async function mainCheckoutFor(path: string): Promise<string | undefined> {
  const { code, stdout } = await run('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (code !== 0) return undefined;
  const gitDir = stdout.trim();
  if (gitDir.length === 0) return undefined;
  // A bare repo has no working tree above its git dir, and is itself the place
  // `git worktree remove` has to run from.
  return basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
}

/**
 * `owner/name` for whatever repo a working tree belongs to, from its origin remote.
 *
 * Asking git rather than the repo index, because the index is keyed by directory
 * name and a task's worktree is not always named after its repo — a stack keeps
 * one directory per branch (`reflow-orders-drop-b2b-flag`), and every one of them
 * is still reflow. Works in a linked worktree, which shares the parent's config.
 */
export async function remoteNameWithOwner(path: string): Promise<string | undefined> {
  const { code, stdout } = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
  return code === 0 ? parseRemote(stdout) : undefined;
}

export async function currentBranch(path: string): Promise<string | undefined> {
  const { code, stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  return code === 0 && branch.length > 0 && branch !== 'HEAD' ? branch : undefined;
}
