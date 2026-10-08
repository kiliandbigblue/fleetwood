import { planReorder, sessionLabel } from '@fleetwood/core/sessionOrder';
import type { MoveDirection } from '@fleetwood/core/sessionOrder';

/*
 * Arranging the fleet from the keyboard, without opening the card's menu.
 *
 * The menu is still where the moves are said in words, and it is the way for a
 * mouse. From the keys it was `m`, down to `arrange`, `→`, down again, Enter —
 * six presses to put one card on top, and no way at all to nudge it one place,
 * which is the move you make most when you are sorting a list by eye. So the
 * card you are on answers to its moves directly, in the vim shape the rest of
 * the list already has: `J`/`K` carry the card where `j`/`k` carry focus.
 *
 * No React and no DOM, so `packages/app/test` can check what each key means at
 * the edges of a group, which is the part that is easy to get wrong.
 */

/** What an arranging key asks of the focused card. */
export type ArrangeIntent = { kind: 'move'; direction: MoveDirection };

/** The keys, as `KeyboardEvent.key` spells them — shifted letters come in capitals. */
export function arrangeIntent(key: string): ArrangeIntent | undefined {
  switch (key) {
    case 'K':
      return { kind: 'move', direction: 'up' };
    case 'J':
      return { kind: 'move', direction: 'down' };
    case 't':
      return { kind: 'move', direction: 'top' };
    case 'b':
      return { kind: 'move', direction: 'bottom' };
    default:
      return undefined;
  }
}

/**
 * Why a move has nothing to do — or `undefined` when it will move.
 *
 * A key that does nothing reads as a broken key, and the reason is almost always
 * the group: a move never leaves the plan, or Other, the card is drawn in, so
 * the first card of a group is as high as it goes even with cards above it.
 * Naming the group is what stops you pressing it again. `order` is that group's
 * shown sessions; `group` is its name, absent when the list has no groups.
 */
export function inertMove(
  order: readonly string[],
  session: string,
  direction: MoveDirection,
  group = 'the list',
): string | undefined {
  if (planReorder(order, session, direction).length > 0) return undefined;
  const end = direction === 'up' || direction === 'top' ? 'first' : 'last';
  return `${sessionLabel(session)} is already ${end} in ${group}`;
}
