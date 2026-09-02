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
 * The last answer, and when it was last checked against the filesystem.
 *
 * In process rather than on disk, and it is what makes the filesystem check
 * affordable: `readTaskRepos` asks for the index once per task and the snapshot
 * runs every second, so without this a five-task fleet would readdir the roots
 * five times a second forever. One pass validates once and the rest of it reads
 * this.
 */
let memo: { index: RepoIndex; checkedAt: number } | undefined;

/**
 * How long an answer stands before the roots are looked at again.
 *
 * Short enough that a repo you just cloned is offerable by the time you have
 * reached for the mouse, long enough that a snapshot pass costs one scan.
 */
const REVALIDATE_MS = 2_000;

function remember(index: RepoIndex): RepoIndex {
  memo = { index, checkedAt: Date.now() };
  return index;
}

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

/** One directory found under the roots, and whether git owns it. */
interface Scanned {
  path: string;
  isRepo: boolean;
}

/**
 * Every directory under the configured roots, in the order the picker shows them.
 *
 * The cheap half of building the index — a readdir per root and a couple of stats
 * per entry, no subprocesses — which is what lets `getIndex` check its cache
 * against the filesystem on every open rather than against the clock.
 */
async function scanRoots(roots: readonly string[]): Promise<Scanned[]> {
  const found: Scanned[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue;
      const path = join(root, entry);
      if (!(await isDirectory(path))) continue;
      // `.git` is a directory in a normal clone and a file in a linked worktree.
      const isRepo = (await isDirectory(join(path, '.git'))) || (await isFile(join(path, '.git')));
      found.push({ path, isRepo });
    }
  }
  return found;
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
 *
 * `reuse` carries the previous index in, and is what makes an incremental rebuild
 * nearly free: the only per-directory cost here is asking git for the origin
 * remote, and a checkout's remote does not change because a repo was cloned next
 * to it. Only genuinely new directories pay for one. Called without it — `fw
 * reindex`, or the age backstop in `getIndex` — every remote is read again, which
 * is the point of that call.
 *
 * `scanned` is the scan `getIndex` already did on its way here, passed through so
 * the roots are walked once per rebuild rather than twice.
 */
export async function buildIndex(reuse?: RepoIndex, scanned?: readonly Scanned[]): Promise<RepoIndex> {
  const config = await loadConfig();
  const known = new Map((reuse?.repos ?? []).map((r) => [r.path, r]));
  const entries = scanned ?? (await scanRoots(config.projectRoots));

  const repos = await Promise.all(
    entries.map(async ({ path, isRepo }): Promise<LocalRepo> => {
      if (!isRepo) return { path, isRepo: false };

      const cached = known.get(path);
      if (cached?.isRepo && cached.nameWithOwner !== undefined) return { ...cached, isRepo: true };

      const { code, stdout } = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
      return { path, isRepo: true, nameWithOwner: code === 0 ? parseRemote(stdout) : undefined };
    }),
  );

  const index: RepoIndex = { builtAt: Math.floor(Date.now() / 1000), repos };
  await ensureDirs();
  await writeFile(CACHE_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return remember(index);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The index, checked against the filesystem rather than against the clock.
 *
 * It used to be the clock alone — serve `repos.json` for fifteen minutes, then
 * rebuild — and the result was that a repo you had just cloned was not offerable
 * for a quarter of an hour. Not only in the picker: `resolveRepoInput` reads this
 * too, so `+ repo` answered "not a git repo under your project roots" about a
 * directory sitting right there. A cache whose staleness you can see on disk
 * beside it is the wrong cache.
 *
 * So what validates it is the scan: the directories under the roots and which of
 * them git owns. The same answer means the cache stands however old it is; any
 * difference rebuilds at once, reusing the remotes it already knows so only what
 * actually changed costs anything. `isRepo` is part of the comparison and not
 * just the paths, so `git init` in a scratch directory you already had promotes
 * it rather than waiting for the backstop.
 *
 * `maxAgeSeconds` remains that backstop, for the one thing a scan cannot see — a
 * remote repointed, a repo renamed on GitHub — and that rebuild is a full one.
 */
export async function getIndex(maxAgeSeconds = 900): Promise<RepoIndex> {
  const now = Date.now();
  const fresh = (index: RepoIndex): boolean => Math.floor(now / 1000) - index.builtAt < maxAgeSeconds;

  if (memo && now - memo.checkedAt < REVALIDATE_MS && fresh(memo.index)) return memo.index;

  let cached = memo?.index;
  if (!cached) {
    try {
      cached = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as RepoIndex;
    } catch {
      // No cache yet.
    }
  }
  if (!cached?.repos || !fresh(cached)) return buildIndex();

  const present = await scanRoots((await loadConfig()).projectRoots);
  const held = new Map(cached.repos.map((r) => [r.path, r.isRepo]));
  const unchanged =
    present.length === held.size && present.every((entry) => held.get(entry.path) === entry.isRepo);
  return unchanged ? remember(cached) : buildIndex(cached, present);
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
