/*
 * Where each session sits in the fleet, written on the session itself.
 *
 * tmux is the source of truth for everything else about a session, so the fleet's
 * order belongs there too rather than in a file fleetwood keeps on the side: a
 * number prefixed to the session name — `20-atlas` is `atlas`, twentieth. It
 * survives restarts, it is editable with `tmux rename-session` alone, and there
 * is no second registry to fall out of sync with the first.
 *
 * The prefix is a display detail, so fleetwood hides it: cards, the palette and
 * `fw status` all show the label. Every action still carries the real name —
 * focus, kill, spawn and the `@fw_*` options are tmux's business and tmux knows
 * the session as `20-atlas`.
 *
 * A leaf module with no `node:` imports, for the reason `naming.ts` and
 * `taskView.ts` are: the renderer needs these and cannot reach anything that
 * pulls in `node:child_process`.
 */

/**
 * Two or more digits and a dash.
 *
 * Two, not one, because a single digit makes real names ambiguous: `2fa-login`
 * is safe either way, but `2-factor-auth` would read as "second in the fleet,
 * called factor-auth" and lose a word off its own name. Nothing is called
 * `20-factor-auth`, and two digits also sort as text in tmux's own listings.
 *
 * The label must be non-empty, so a session literally named `20-` keeps its name
 * instead of rendering as a blank card.
 */
const ORDER_PREFIX = /^(\d{2,})-(.+)$/;

/** The step between slots: gaps so a number can be typed in between two others. */
export const ORDER_STEP = 10;

export interface SessionName {
  /** Absent when the session has no prefix — an opinion nobody has expressed. */
  order?: number;
  /** The name with its prefix taken off: what fleetwood shows. */
  label: string;
}

export function parseSessionName(name: string): SessionName {
  const match = ORDER_PREFIX.exec(name);
  if (!match) return { label: name };
  return { order: Number.parseInt(match[1] as string, 10), label: match[2] as string };
}

/** What to show for a session. */
export function sessionLabel(name: string): string {
  return parseSessionName(name).label;
}

/** Its slot, or `undefined` when it has none. */
export function sessionOrder(name: string): number | undefined {
  return parseSessionName(name).order;
}

/**
 * The same session, in a given slot — or with no prefix at all when `order` is
 * `undefined`.
 *
 * Zero-padded to two digits so slot 5 is `05-` and sorts before `10-` in any
 * plain text listing, tmux's own included.
 */
export function nameWithOrder(name: string, order: number | undefined): string {
  const { label } = parseSessionName(name);
  if (order === undefined) return label;
  return `${String(Math.max(0, Math.trunc(order))).padStart(2, '0')}-${label}`;
}

/**
 * Whether two names are the same session, prefix or no prefix.
 *
 * Every find-or-create path in fleetwood recognises a session by the name it
 * would have given it — `openProject`, `ensureTaskSession`, the PR session's
 * last-resort match. Comparing raw names there would see `20-fleetwood` as a
 * stranger and create a second session called `fleetwood`, which is the one
 * failure this whole feature could plausibly cause.
 */
export function sameSession(a: string, b: string): boolean {
  return sessionLabel(a) === sessionLabel(b);
}

/** The little of a session the fleet's order depends on. */
export interface Orderable {
  name: string;
  needsAttention: boolean;
  agents: readonly unknown[];
}

/**
 * The fleet, in the order it is shown.
 *
 * A slot is absolute: a numbered session sits where you put it, and a blocked
 * agent does not jump the queue — that is what asking for a hand-edited order
 * means, and a list that rearranges itself under you is exactly what the numbers
 * are for. Unnumbered sessions follow, and among *them* fleetwood's own reading
 * still applies: whoever needs you first, then sessions with agents in them, then
 * tmux's creation order.
 *
 * So the numbers are opt-in per session. Number nothing and this is the list
 * fleetwood always drew; number one thing and only that one is pinned.
 */
export function sortSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index, order: sessionOrder(session.name) }))
    .sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        if (a.order !== b.order) return a.order - b.order;
      } else if (a.order !== undefined) return -1;
      else if (b.order !== undefined) return 1;

      // Unnumbered, or two sessions sharing a slot: fleetwood's own reading.
      if (a.session.needsAttention !== b.session.needsAttention) {
        return a.session.needsAttention ? -1 : 1;
      }
      const aAgents = a.session.agents.length > 0;
      const bAgents = b.session.agents.length > 0;
      if (aAgents !== bAgents) return aAgents ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.session);
}

export interface SessionRename {
  from: string;
  to: string;
}

/** A move, in the words the buttons use. */
export type MoveDirection = 'up' | 'down' | 'top' | 'bottom';

/**
 * The renames that move one session up or down the fleet — a slot at a time, or
 * all the way to one end.
 *
 * Takes the order as it is *displayed*, because that is the list the click was
 * made against — "up" has to mean "above the card I can see above this one",
 * whatever mixture of numbered and unnumbered sessions produced it.
 *
 * Then it numbers the whole list. The alternative — swapping two neighbours'
 * numbers — only works when both already have one: give a number to a session
 * sitting in the unnumbered tail and it leaps over every numbered session ahead
 * of it, because a slot outranks everything. Numbering all of them is the only
 * form of this that behaves the same wherever you click. The cost is that the
 * first move renames every session; after that a move renames the two that
 * swapped, since only their numbers change.
 *
 * Empty when the session is already at that end of the list, or is not in it.
 */
export function planReorder(
  order: readonly string[],
  name: string,
  direction: MoveDirection,
): SessionRename[] {
  const from = order.indexOf(name);
  if (from < 0) return [];
  const to =
    direction === 'top'
      ? 0
      : direction === 'bottom'
        ? order.length - 1
        : direction === 'up'
          ? from - 1
          : from + 1;
  if (to < 0 || to >= order.length || to === from) return [];

  const moved = [...order];
  moved.splice(to, 0, ...moved.splice(from, 1));

  const renames: SessionRename[] = [];
  moved.forEach((current, index) => {
    const next = nameWithOrder(current, (index + 1) * ORDER_STEP);
    if (next !== current) renames.push({ from: current, to: next });
  });
  return renames;
}
