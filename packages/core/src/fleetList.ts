import type { SessionMeta } from './types.ts';

/*
 * Which tmux sessions the fleet list is for.
 *
 * tmux is the source of truth for what exists, and it holds far more than the
 * fleet is about: the shell you keep open in `~`, the session you spawned to try
 * one command, every project you have ever attached to. Listing all of them made
 * the panel a `tmux ls` with cards — and the one question it exists to answer,
 * what is every agent doing and what needs me, got answered further and further
 * down the page.
 *
 * So the list is the work fleetwood set up: a task, or a pull request. Both stamp
 * `@fw_kind` on the session at creation, which is exactly the line we want —
 * fleetwood knows why those sessions exist and has something to say about them,
 * and a session it never created is a terminal you opened, which it does not.
 * Nothing is marked; a session qualifies by what it is.
 *
 * The one thing configured is a workspace: a folder you coordinate from, like
 * `~/projects/os`, where no task is ever made and so nothing stamps a kind. It
 * is work all the same, and naming it in `workspaces` is fleetwood being told
 * why the session exists — which is the line this list draws.
 *
 * This is not the hidden fold in `sessionOrder.ts`, and the two do not meet. That
 * one is a decision you make about a session that belongs in the list, written on
 * its name, reversible from its own menu, and the card is still there behind a
 * divider. This is the list's subject, so there is no drawer and no card: a
 * session that is not the fleet's business does not appear in it at all. What it
 * is doing still reaches the header — the counts and the status bar are read off
 * every session, blocked agents in these included, because an agent nobody is
 * looking at is still spending a token. And the palette still switches to any
 * session tmux has, which is how you get back to one of these.
 *
 * A leaf module with no `node:` imports, for the reason `sessionOrder.ts` and
 * `taskView.ts` are: the renderer needs this and cannot reach anything that pulls
 * in `node:child_process`. The import above is type-only, so it brings nothing.
 */

/**
 * Whether the fleet list is about this session.
 *
 * `@fw_task` is checked beside the kind rather than trusting the kind alone: a
 * session fleetwood adopted onto a task carries both, and one stamped before
 * `@fw_kind` existed — or by hand, which the whole `@fw_*` scheme invites —
 * carries only the task. Missing a task session is the failure that matters here,
 * since a card that vanishes looks like a session that died.
 */
export function isWorkSession(meta: SessionMeta): boolean {
  return (
    meta.kind === 'task' || meta.kind === 'pr' || meta.kind === 'workspace' || meta.task !== undefined
  );
}

/** One spelling per directory: `~/projects/os/` and `~/projects/os` are one place. */
function samePath(a: string, b: string): boolean {
  const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  return trim(a) === trim(b);
}

/**
 * The sessions, with the ones rooted at a workspace marked as such.
 *
 * Read off `session_path` rather than stamped as `@fw_kind` when fleetwood opens
 * one. A stamp would only cover the sessions fleetwood made, and a workspace is
 * the case where it often did not: `prefix+g`, the sessionizer or a plain
 * `tmux new -c` all make the same session, and a restored one loses its user
 * options anyway. The directory is the fact that survives all of them.
 *
 * A session that already says what it is keeps its word — a task session is a
 * task session wherever it was started.
 */
export function markWorkspaces<T extends { path: string; meta: SessionMeta }>(
  sessions: readonly T[],
  workspaces: readonly string[],
): T[] {
  return sessions.map((session) =>
    session.meta.kind === undefined &&
    session.meta.task === undefined &&
    workspaces.some((dir) => samePath(dir, session.path))
      ? { ...session, meta: { ...session.meta, kind: 'workspace' } }
      : session,
  );
}

/**
 * Workspaces with no session rooted at them, in the order they are configured.
 *
 * The dormant tasks' counterpart: without a card of its own, a workspace nobody
 * has opened yet would be the one piece of work the list has no way into.
 */
export function dormantWorkspaces(
  sessions: readonly { path: string }[],
  workspaces: readonly string[],
): string[] {
  return workspaces.filter((dir) => !sessions.some((session) => samePath(dir, session.path)));
}
