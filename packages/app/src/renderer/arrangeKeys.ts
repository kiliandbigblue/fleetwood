import { isPinned, planReorder, sessionLabel } from '@fleetwood/core/sessionOrder';
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
 * the edges of a tier, which is the part that is easy to get wrong.
 */

/** What an arranging key asks of the focused card. */
export type ArrangeIntent = { kind: 'move'; direction: MoveDirection } | { kind: 'pin' };

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
    case 'p':
      return { kind: 'pin' };
    default:
      return undefined;
  }
}

/**
 * Why a move has nothing to do, in the words of the tier the card is in — or
 * `undefined` when it will move.
 *
 * A key that does nothing reads as a broken key, and the reason is almost always
 * the pins: `t` on the first unpinned card is already as high as it can go, and
 * saying "already first below the pins" is what stops you pressing it again.
 */
export function inertMove(order: readonly string[], session: string, direction: MoveDirection): string | undefined {
  if (planReorder(order, session, direction).length > 0) return undefined;
  const label = sessionLabel(session);
  const pinned = isPinned(session);
  const up = direction === 'up' || direction === 'top';
  if (up) return `${label} is already ${pinned ? 'first of the pinned' : 'first below the pins'}`;
  return `${label} is already ${pinned ? 'last of the pinned' : 'last in the list'}`;
}
