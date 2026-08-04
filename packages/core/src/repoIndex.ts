import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FW_HOME, ensureDirs } from './paths.ts';
import { run } from './exec.ts';
import { loadConfig } from './config.ts';

export interface LocalRepo {
  /** Absolute path of the working tree. */
  path: string;
  /** "owner/name" from the origin remote, when there is one. */
  nameWithOwner?: string;
  /** False for plain directories — still worth a session, just not a repo. */
  isRepo: boolean;
  defaultBranch?: string;
}

export interface RepoIndex {
  builtAt: number;
  repos: LocalRepo[];
}

const CACHE_FILE = join(FW_HOME, 'repos.json');

/**
 * Extract owner/name from any remote URL shape git uses.
 *
 * Handles scp-style (`git@github.com:owner/repo.git`), https, ssh:// and the
 * insteadOf-rewritten forms that show up in work setups.
 */
export function parseRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (trimmed.length === 0) return undefined;
  const scp = /^[^@\s]+@[^:]+:(.+)$/.exec(trimmed);
  if (scp?.[1]) return normalizeSlug(scp[1]);
  const proto = /^[a-z+]+:\/\/[^/]+\/(.+)$/i.exec(trimmed);
  if (proto?.[1]) return normalizeSlug(proto[1]);
  return undefined;
}

function normalizeSlug(pathPart: string): string | undefined {
  const parts = pathPart.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  // Take the last two segments so self-hosted paths with prefixes still work.
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover projects under the configured roots.
 *
 * Every directory counts, not just git repos — this has to offer the same list as
 * the existing tmux-sessionizer, which fzf's over all of `~/projects` and
 * `~/dotfiles`. A scratch directory with no `.git` is still somewhere you start a
 * session, and omitting those made the palette quietly narrower than `prefix+g`.
 *
 * One level deep only: descending further would walk into node_modules and, worse,
 * into the worktrees fleetwood itself creates.
 */
export async function buildIndex(): Promise<RepoIndex> {
  const config = await loadConfig();
  const repos: LocalRepo[] = [];

  for (const root of config.projectRoots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const path = join(root, entry);
      if (!(await isDirectory(path))) continue;

      // `.git` is a directory in a normal clone and a file in a linked worktree.
      const isRepo =
        (await isDirectory(join(path, '.git'))) || (await isFile(join(path, '.git')));
      if (!isRepo) {
        repos.push({ path, isRepo: false });
        continue;
      }

      const { code, stdout } = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
      repos.push({
        path,
        isRepo: true,
        nameWithOwner: code === 0 ? parseRemote(stdout) : undefined,
      });
    }
  }

  const index: RepoIndex = { builtAt: Math.floor(Date.now() / 1000), repos };
  await ensureDirs();
  await writeFile(CACHE_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Cached index, rebuilt when older than `maxAgeSeconds`. */
export async function getIndex(maxAgeSeconds = 900): Promise<RepoIndex> {
  try {
    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as RepoIndex;
    if (Math.floor(Date.now() / 1000) - cached.builtAt < maxAgeSeconds) return cached;
  } catch {
    // No cache yet.
  }
  return buildIndex();
}

/**
 * Local checkout for a GitHub repo, or undefined if it isn't cloned here.
 *
 * Several directories can share one origin — a clone plus its demo or scratch
 * copy — so the directory actually named after the repo wins rather than
 * whichever the filesystem listed first.
 */
export async function resolveRepo(nameWithOwner: string): Promise<LocalRepo | undefined> {
  const index = await getIndex();
  const wanted = nameWithOwner.toLowerCase();
  const candidates = index.repos.filter((r) => r.nameWithOwner?.toLowerCase() === wanted);
  if (candidates.length <= 1) return candidates[0];
  const repoName = wanted.split('/')[1];
  return candidates.find((r) => r.path.split('/').pop()?.toLowerCase() === repoName) ?? candidates[0];
}
