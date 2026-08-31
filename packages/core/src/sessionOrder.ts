/*
 * Where each session sits in the fleet, written on the session itself.
 *
 * tmux is the source of truth for everything else about a session, so the fleet's
 * order belongs there too rather than in a file fleetwood keeps on the side: a
 * number prefixed to the session name — `20-atlas` is `atlas`, twentieth. It
 * survives restarts, it is editable with `tmux rename-session` alone, and there
 * is no second registry to fall out of sync with the first.
 *
 * A pin is the same idea one step up: a `+` before the slot puts the session in
 * a tier of its own — `+20-atlas` sorts above every unpinned session whatever
 * their numbers, and "move to top" on an unpinned card means the top of the
 * unpinned tier, not the top of the panel. That is what a pin is for: a
 * short-list that stays on top while the rest of the fleet is reshuffled under
 * it. It lives in the name for the reason the slot does — one mechanism, no
 * registry, and `tmux rename-session` is still enough to do it by hand.
 *
 * Hiding is the third of these, and the only one that is not about position: a
 * `-` in front of everything else takes the session out of the fleet list
 * altogether — `-+20-atlas` is that same pinned, twentieth `atlas`, folded away
 * at the bottom of the panel. Nothing about the session changes; the agents in
 * it keep running and keep being counted. Read outside in, the three markers are
 * the three questions in the order they are asked: is it in the list, which tier,
 * where in the tier.
 *
 * The prefix is a display detail, so fleetwood hides it: cards, the palette and
 * `fw status` all show the label. Every action still carries the real name —
 * focus, kill, spawn and the `@fw_*` options are tmux's business and tmux knows
 * the session as `+20-atlas`.
 *
 * A leaf module with no `node:` imports, for the reason `naming.ts` and
 * `taskView.ts` are: the renderer needs these and cannot reach anything that
 * pulls in `node:child_process`.
 */

/**
 * An optional hidden marker, then an optional pin, then an optional slot, then
 * the name itself.
 *
 * The slot is two or more digits and a dash. Two, not one, because a single digit
 * makes real names ambiguous: `2fa-login` is safe either way, but
 * `2-factor-auth` would read as "second in the fleet, called factor-auth" and
 * lose a word off its own name. Nothing is called `20-factor-auth`, and two
 * digits also sort as text in tmux's own listings.
 *
 * The pin marker is a leading `+`, and it comes before the slot: `+20-atlas` is
 * `atlas`, twentieth, pinned. `+` rather than `!` or `*` because the name has to
 * survive being typed — `tmux attach -t '!20-atlas'` is a history expansion in
 * an interactive shell, and a marker you have to quote is a marker that makes
 * `tmux rename-session` a worse tool than fleetwood.
 *
 * The hidden marker is a `-` and it comes before the pin, because it outranks
 * it: a session that is not in the list is not in a tier of it either, and this
 * is the order in which the two are decided. So `-+20-atlas` is a hidden,
 * pinned, twentieth `atlas`, and unhiding it puts it back at the top of the
 * pinned tier rather than anywhere new.
 *
 * A leading `-` is the one marker that costs something: tmux reads it as flags,
 * so `tmux.renameSession` passes `--` before the new name. It is still the right
 * character, by the rule that picked `+` over `!` — the marker has to survive
 * being typed, and `tmux rename-session -t atlas -- -atlas` is a hand-edit,
 * while a quoted marker is a trap.
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
  /** Whether the session is in the pinned tier, above every unpinned one. */
  pinned: boolean;
  /** Whether the fleet list leaves it out, folded under `hidden` instead. */
  hidden: boolean;
  /** The name with its prefix taken off: what fleetwood shows. */
  label: string;
}

export function parseSessionName(name: string): SessionName {
  const match = NAME_PREFIX.exec(name);
  if (!match) return { pinned: false, hidden: false, label: name };
  const digits = match[3];
  return {
    ...(digits === undefined ? {} : { order: Number.parseInt(digits, 10) }),
    hidden: match[1] === '-',
    pinned: match[2] === '+',
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

/** Whether it is pinned to the top tier. */
export function isPinned(name: string): boolean {
  return parseSessionName(name).pinned;
}

/** Whether the fleet list leaves this one out. */
export function isHidden(name: string): boolean {
  return parseSessionName(name).hidden;
}

/**
 * A name back from its parts — the one place the markers are assembled.
 *
 * One place because there are three of them now and each `nameWith*` changes a
 * single part: a second copy of this is how a marker gets dropped by the
 * function that was not thinking about it.
 *
 * Zero-padded to two digits so slot 5 is `05-` and sorts before `10-` in any
 * plain text listing, tmux's own included.
 */
function composeName({ hidden, pinned, order, label }: SessionName): string {
  const slot =
    order === undefined ? '' : `${String(Math.max(0, Math.trunc(order))).padStart(2, '0')}-`;
  return `${hidden ? '-' : ''}${pinned ? '+' : ''}${slot}${label}`;
}

/**
 * The same session, in a given slot — or with no slot at all when `order` is
 * `undefined`.
 *
 * Neither a pin nor the fold is a position, so both ride along untouched:
 * renumbering the fleet must not quietly unpin half of it, nor lift a card out
 * of the fold and back onto the screen.
 */
export function nameWithOrder(name: string, order: number | undefined): string {
  return composeName({ ...parseSessionName(name), order });
}

/**
 * The same session, pinned or not — its slot kept either way.
 *
 * Pinning is deliberately not a move: a pinned session keeps the number it had,
 * so unpinning drops it back where it was in the unpinned tier rather than
 * somewhere the pin invented for it.
 */
export function nameWithPin(name: string, pinned: boolean): string {
  return composeName({ ...parseSessionName(name), pinned });
}

/**
 * The same session, hidden or shown — its tier and its slot kept either way.
 *
 * The fold is not a move either, for the same reason and with a longer way back:
 * a session hidden out of slot 20 of the pinned tier comes back into slot 20 of
 * the pinned tier. Hiding a pinned session does not unpin it — that would make
 * the fold quietly destructive of the other marker — it just means the pin has
 * nothing to be above until the session is shown again.
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
 * Pinned sessions come first, as a block: that is the whole of what a pin does,
 * and it outranks the numbers because a short-list that a renumber could break
 * out of would not be a short-list. Inside each tier a slot is absolute — a
 * numbered session sits where you put it, and a blocked agent does not jump the
 * queue, because that is what asking for a hand-edited order means and a list
 * that rearranges itself under you is exactly what the numbers are for.
 * Unnumbered sessions follow, and among *them* fleetwood's own reading still
 * applies: whoever needs you first, then sessions with agents in them, then
 * tmux's creation order.
 *
 * So both markers are opt-in per session. Mark nothing and this is the list
 * fleetwood always drew; number one thing and only that one is placed; pin one
 * thing and only that one is held on top.
 */
export function sortSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index, ...parseSessionName(session.name) }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

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
 * Every move stays inside the session's own tier: "top" for an unpinned session
 * is the first row below the pins, and "up" from the row under them does
 * nothing. Letting it aim higher would rename the fleet and change nothing on
 * screen, because the sort puts the pins back on top afterwards — a button that
 * reports success and visibly does nothing is worse than one that is plainly
 * disabled. The tiers are contiguous in a displayed order because that is how
 * `sortSessions` drew it.
 *
 * Then it numbers the whole list. The alternative — swapping two neighbours'
 * numbers — only works when both already have one: give a number to a session
 * sitting in the unnumbered tail and it leaps over every numbered session ahead
 * of it, because a slot outranks everything. Numbering all of them is the only
 * form of this that behaves the same wherever you click. The cost is that the
 * first move renames every session; after that a move renames the two that
 * swapped, since only their numbers change.
 *
 * Empty when the session is already at that end of its tier, or is not in the
 * list.
 */
export function planReorder(
  order: readonly string[],
  name: string,
  direction: MoveDirection,
): SessionRename[] {
  const from = order.indexOf(name);
  if (from < 0) return [];

  // The run of same-tier rows around it: the ends "top" and "bottom" mean here.
  const tier = isPinned(name);
  let first = from;
  while (first > 0 && isPinned(order[first - 1] as string) === tier) first -= 1;
  let last = from;
  while (last < order.length - 1 && isPinned(order[last + 1] as string) === tier) last += 1;

  const to =
    direction === 'top'
      ? first
      : direction === 'bottom'
        ? last
        : direction === 'up'
          ? from - 1
          : from + 1;
  if (to < first || to > last || to === from) return [];

  const moved = [...order];
  moved.splice(to, 0, ...moved.splice(from, 1));

  const renames: SessionRename[] = [];
  moved.forEach((current, index) => {
    const next = nameWithOrder(current, (index + 1) * ORDER_STEP);
    if (next !== current) renames.push({ from: current, to: next });
  });
  return renames;
}
