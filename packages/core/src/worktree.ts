import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './exec.ts';
import { loadConfig } from './config.ts';

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
    return { ok: false, detail: `refusing: ${files} uncommitted change(s) in ${worktreePath}` };
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

export async function currentBranch(path: string): Promise<string | undefined> {
  const { code, stdout } = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  return code === 0 && branch.length > 0 && branch !== 'HEAD' ? branch : undefined;
}
