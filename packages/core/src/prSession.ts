import { basename } from 'node:path';
import { focusSession } from './actions.ts';
import { prKey } from './github.ts';
import type { PullRequest } from './github.ts';
import { resolveRepo } from './repoIndex.ts';
import * as tmux from './tmux.ts';
import { ensureWorktreeForPr, listWorktrees, removeWorktree } from './worktree.ts';

export interface PrSessionMatch {
  session: string;
  /** How we recognised it, which is worth showing when it's a fuzzy match. */
  by: 'stamp' | 'worktree' | 'name';
}

/** tmux forbids `.` and `:` in session names. */
function sanitize(name: string): string {
  return name.replaceAll('.', '_').replaceAll(':', '_');
}

export function prSessionName(repo: string, prNumber: number): string {
  return sanitize(`${basename(repo)}-pr-${prNumber}`);
}

/**
 * Find the session already working on a PR.
 *
 * Three strategies, most reliable first. The stamp is authoritative; the others
 * catch sessions you created by hand before fleetwood knew about the PR, which is
 * the common case early on.
 */
export async function findSessionForPr(
  repo: string,
  prNumber: number,
  branch: string | undefined,
): Promise<PrSessionMatch | undefined> {
  const sessions = await tmux.listSessions();
  const key = prKey(repo, prNumber);

  const stamped = sessions.find((s) => s.meta.pr === key);
  if (stamped) return { session: stamped.name, by: 'stamp' };

  if (branch) {
    const byBranch = sessions.find((s) => s.meta.branch === branch && s.meta.repo === repo);
    if (byBranch) return { session: byBranch.name, by: 'stamp' };

    // No stamp: match a session whose directory is a worktree on the branch.
    const local = await resolveRepo(repo);
    if (local) {
      const worktrees = await listWorktrees(local.path);
      const onBranch = worktrees.filter((w) => w.branch === branch).map((w) => w.path);
      if (onBranch.length > 0) {
        const match = sessions.find((s) => onBranch.some((p) => s.path === p || s.path.startsWith(`${p}/`)));
        if (match) return { session: match.name, by: 'worktree' };
      }
    }
  }

  const expected = prSessionName(repo, prNumber);
  const byName = sessions.find((s) => s.name === expected);
  return byName ? { session: byName.name, by: 'name' } : undefined;
}

export interface OpenPrResult {
  ok: boolean;
  session?: string;
  worktree?: string;
  created: boolean;
  detail: string;
}

export interface OpenPrOptions {
  /** Create the session but leave focus where it is. */
  background?: boolean;
}

/**
 * Open a PR: focus its session if one exists, otherwise build one.
 *
 * Building means a dedicated worktree so reviewing never disturbs the main
 * checkout, a detached tmux session rooted there, and metadata stamped onto the
 * session so the next click finds it instead of making a second one.
 */
export async function openPr(pr: PullRequest, options: OpenPrOptions = {}): Promise<OpenPrResult> {
  const existing = await findSessionForPr(pr.repo, pr.number, pr.branch);
  if (existing) {
    if (options.background) {
      return { ok: true, session: existing.session, created: false, detail: `session ${existing.session} already exists` };
    }
    const focus = await focusSession(existing.session);
    return {
      ok: focus.ok,
      session: existing.session,
      created: false,
      detail: `focused ${existing.session} (matched by ${existing.by})`,
    };
  }

  const local = await resolveRepo(pr.repo);
  if (!local) {
    return { ok: false, created: false, detail: `${pr.repo} is not cloned under your project roots — clone it first` };
  }

  const worktree = await ensureWorktreeForPr(local.path, pr.number, pr.branch);
  if (!worktree.ok || !worktree.path) {
    return { ok: false, created: false, detail: worktree.detail };
  }

  const name = prSessionName(pr.repo, pr.number);
  const created = await tmux.newSession({ name, cwd: worktree.path, windowName: 'review' });
  if (!created) {
    return { ok: false, worktree: worktree.path, created: false, detail: `worktree ready at ${worktree.path}, but tmux refused to create ${name}` };
  }

  await tmux.setSessionMeta(name, {
    kind: 'pr',
    repo: pr.repo,
    branch: worktree.branch ?? pr.branch,
    pr: prKey(pr.repo, pr.number),
    worktree: worktree.path,
  });

  if (options.background) {
    return { ok: true, session: name, worktree: worktree.path, created: true, detail: `created ${name} (${worktree.detail})` };
  }

  const focus = await focusSession(name);
  return {
    ok: true,
    session: name,
    worktree: worktree.path,
    created: true,
    detail: `created and focused ${name} — ${worktree.detail}${focus.ok ? '' : ` (focus failed: ${focus.detail})`}`,
  };
}

/**
 * Tear down a PR session and its worktree.
 *
 * Reads the worktree path off the session's own metadata, so it can only ever
 * remove something fleetwood created and recorded.
 */
export async function archivePrSession(sessionName: string, force = false): Promise<OpenPrResult> {
  const sessions = await tmux.listSessions();
  const session = sessions.find((s) => s.name === sessionName);
  if (!session) return { ok: false, created: false, detail: `no session named ${sessionName}` };

  const worktreePath = session.meta.worktree;
  const repo = session.meta.repo;

  if (worktreePath && repo) {
    const local = await resolveRepo(repo);
    if (local) {
      const removal = await removeWorktree(local.path, worktreePath, force);
      if (!removal.ok) return { ok: false, created: false, detail: removal.detail };
    }
  }

  const killed = await tmux.killSession(sessionName);
  if (!killed) return { ok: false, created: false, detail: `removed the worktree but could not kill ${sessionName}` };

  // Be explicit when there was nothing to clean up: a session stamped as a PR but
  // missing its worktree path means something left a directory behind, and
  // silently reporting success would hide that.
  if (worktreePath) return { ok: true, created: false, detail: `archived ${sessionName} and removed ${worktreePath}` };
  return {
    ok: true,
    created: false,
    detail:
      session.meta.kind === 'pr'
        ? `killed ${sessionName}, but it had no recorded worktree — check for a leftover directory`
        : `killed ${sessionName} (no worktree to remove)`,
  };
}
