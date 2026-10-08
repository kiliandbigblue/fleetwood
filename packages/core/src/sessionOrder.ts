/*
 * Where each session sits in the fleet, written on the session itself.
 *
 * tmux is the source of truth for everything else about a session, so the fleet's
 * order belongs there too rather than in a file fleetwood keeps on the side: a
 * number prefixed to the session name — `20-atlas` is `atlas`, twentieth. It
 * survives restarts, it is editable with `tmux rename-session` alone, and there
 * is no second registry to fall out of sync with the first.
 *
 * Hiding is the other marker, and not about position: a `-` in front of the
 * slot takes the session out of the fleet list altogether — `-20-atlas` is that
 * same twentieth `atlas`, folded away at the bottom of the panel. Nothing about
 * the session changes; the agents in it keep running and keep being counted.
 *
 * There used to be a third, a `+` pin holding a session in a tier above the
 * rest. The fleet list is grouped by plan now, and a tier above the groups had
 * nothing left to mean, so it went. Names written under it still carry the `+`:
 * it is read past, ignored for order, and dropped the next time the name is
 * rewritten.
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
 * An optional hidden marker, then an optional old pin, then an optional slot,
 * then the name itself.
 *
 * The slot is two or more digits and a dash. Two, not one, because a single digit
 * makes real names ambiguous: `2fa-login` is safe either way, but
 * `2-factor-auth` would read as "second in the fleet, called factor-auth" and
 * lose a word off its own name. Nothing is called `20-factor-auth`, and two
 * digits also sort as text in tmux's own listings.
 *
 * The old pin's `+` sat between the two, so `-+20-atlas` is still read as a
 * hidden, twentieth `atlas`; nothing reads the `+` itself any more.
 *
 * A leading `-` costs something: tmux reads it as flags, so
 * `tmux.renameSession` passes `--` before the new name. It is still the right
 * character — the marker has to survive being typed, and
 * `tmux rename-session -t atlas -- -atlas` is a hand-edit, while a marker you
 * have to quote (`!` is a history expansion) is a trap.
 *
 * Every part is optional and each is only a marker when a name is left over, so
 * a session literally called `20-`, `+` or `-` keeps its name instead of
 * rendering as a blank card.
 */
const NAME_PREFIX = /^(-?)(\+?)(?:(\d{2,})-)?(.+)$/;

export const ORDER_STEP = 10;

export interface SessionName {
  /** Absent when the session has no slot — an opinion nobody has expressed. */
  order?: number;
  /** Whether the fleet list leaves it out, folded under `hidden` instead. */
  hidden: boolean;
  /** The name with its prefix taken off: what fleetwood shows. */
  label: string;
}

export function parseSessionName(name: string): SessionName {
  const match = NAME_PREFIX.exec(name);
  if (!match) return { hidden: false, label: name };
  const digits = match[3];
  return {
    ...(digits === undefined ? {} : { order: Number.parseInt(digits, 10) }),
    hidden: match[1] === '-',
    label: match[4] as string,
  };
}

/** What to show for a session. */
export function sessionLabel(name: string): string {
  return parseSessionName(name).label;
}

/** Its slot, or `undefined` when it has none. */
export function sessionOrder(name: string): number | undefined {
  return parseSessionName(name).order;
}

/** Whether the fleet list leaves this one out. */
export function isHidden(name: string): boolean {
  return parseSessionName(name).hidden;
}

/**
 * A name back from its parts — the one place the markers are assembled.
 *
 * One place because each `nameWith*` changes a single part: a second copy of
 * this is how a marker gets dropped by the function that was not thinking about
 * it. An old pin's `+` is never written back — this is where it is dropped.
 *
 * Zero-padded to two digits so slot 5 is `05-` and sorts before `10-` in any
 * plain text listing, tmux's own included.
 */
function composeName({ hidden, order, label }: SessionName): string {
  const slot =
    order === undefined ? '' : `${String(Math.max(0, Math.trunc(order))).padStart(2, '0')}-`;
  return `${hidden ? '-' : ''}${slot}${label}`;
}

/**
 * The same session, in a given slot — or with no slot at all when `order` is
 * `undefined`.
 *
 * The fold is not a position, so it rides along untouched: renumbering the
 * fleet must not lift a card out of the fold and back onto the screen.
 */
export function nameWithOrder(name: string, order: number | undefined): string {
  return composeName({ ...parseSessionName(name), order });
}

/**
 * The same session, hidden or shown — its slot kept either way.
 *
 * The fold is not a move: a session hidden out of slot 20 comes back into
 * slot 20.
 */
export function nameWithHidden(name: string, hidden: boolean): string {
  return composeName({ ...parseSessionName(name), hidden });
}

/**
 * Whether two names are the same session, prefix or no prefix.
 *
 * Every find-or-create path in fleetwood recognises a session by the name it
 * would have given it — `openProject`, `ensureTaskSession`, the PR session's
 * last-resort match. Comparing raw names there would see `20-fleetwood` as a
 * stranger and create a second session called `fleetwood`, which is the one
 * failure this whole feature could plausibly cause. Hiding is the same hazard
 * with a louder failure — a hidden session nothing can find again — and is
 * covered by the same comparison: `-fleetwood` is `fleetwood`.
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
 * A slot is absolute — a numbered session sits where you put it, and a blocked agent does not jump the
 * queue, because that is what asking for a hand-edited order means and a list
 * that rearranges itself under you is exactly what the numbers are for.
 * Unnumbered sessions follow: sessions with agents in them, then tmux's
 * creation order. Not "whoever needs you first" any more — that rank moved a
 * card the moment its agent blocked, which is the one moment you are reaching
 * for it. A blocked card gets louder where it is, and `n` in the panel goes to
 * it; the list itself holds still.
 *
 * So the slot is opt-in per session. Number nothing and this is the list
 * fleetwood always drew; number one thing and only that one is placed. An old
 * pin's `+` is ignored.
 */
export function sortSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index, ...parseSessionName(session.name) }))
    .sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        if (a.order !== b.order) return a.order - b.order;
      } else if (a.order !== undefined) return -1;
      else if (b.order !== undefined) return 1;

      // Unnumbered, or two sessions sharing a slot: fleetwood's own reading.
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
 * The order is one group's, not the whole fleet's: the list is grouped by plan,
 * and a move never crosses into another group, so the caller hands over only
 * the group the session is drawn in. Numbers repeat across groups and that is
 * fine — each group sorts its own members.
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

  const last = order.length - 1;
  const to =
    direction === 'top'
      ? 0
      : direction === 'bottom'
        ? last
        : direction === 'up'
          ? from - 1
          : from + 1;
  if (to < 0 || to > last || to === from) return [];

  const moved = [...order];
  moved.splice(to, 0, ...moved.splice(from, 1));

  const renames: SessionRename[] = [];
  moved.forEach((current, index) => {
    const next = nameWithOrder(current, (index + 1) * ORDER_STEP);
    if (next !== current) renames.push({ from: current, to: next });
  });
  return renames;
}
