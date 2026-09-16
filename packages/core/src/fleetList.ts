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
 * Nothing is marked and nothing is configured; a session qualifies by what it is.
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
  return meta.kind === 'task' || meta.kind === 'pr' || meta.task !== undefined;
}
