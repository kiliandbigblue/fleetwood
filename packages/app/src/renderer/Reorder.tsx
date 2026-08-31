import { useRef, useState } from 'react';
import { isHidden, isPinned, sessionLabel, sessionOrder } from '@fleetwood/core/sessionOrder';
import type { MoveDirection } from '@fleetwood/core/sessionOrder';
import { send } from './api.ts';
import { useDismiss } from './useDismiss.ts';

interface Props {
  /**
   * The tmux session this card is showing.
   *
   * A card with no session cannot be ordered — the slot lives on the session
   * name, so a dormant task has nowhere to keep one.
   */
  session: string;
  /** Session names in the order the panel is drawing them right now. */
  order: string[];
  onResult: (message: string, ok: boolean) => void;
}

/**
 * Where this card sits in the fleet: one door, four moves behind it.
 *
 * A row of arrows was the first shape this took, and four glyphs on every card
 * is four glyphs — quieter faded, but the same amount of furniture in a panel
 * whose top line is supposed to be status. So the card carries a single dot
 * column, dim until you point at it (the rule `.agent-kill` already follows),
 * and the moves are words in a popover rather than arrows to decode. It also
 * gives the slot number somewhere to live, and the next per-card action
 * somewhere to go without a fifth glyph appearing in the header.
 *
 * The trade is two clicks per move. That is the right way round for this
 * control: the moves worth a keystroke are "to the top" and "to the bottom",
 * and both were always going to be their own item rather than ten clicks of a
 * neighbouring arrow.
 *
 * Every move is sent with the order the panel is currently drawing, so "up one"
 * means the card above this one and nothing has to agree about anything else.
 * What it does is rename the tmux session's number prefix, which is why the menu
 * says which slot the card is in: the effect outlives fleetwood, and
 * `tmux rename-session` or `fw order` will do the same thing.
 *
 * The moves are bounded by the card's own tier, which is why "move to top" can
 * be inert on a card that is not at the top of the panel: a pinned short-list
 * sits above, and the top this card has is the top of the unpinned list. The
 * last item is the tier itself — a pin is the one thing in here that changes
 * which rows the other four are about.
 */
export function Reorder({ session, order, onResult }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useDismiss(wrapRef, open, () => setOpen(false));

  const pinned = isPinned(session);
  const hidden = isHidden(session);
  const index = order.indexOf(session);
  // The ends of this card's tier, not of the panel: the moves stop at the pins.
  const above = index > 0 ? order[index - 1] : undefined;
  const below = index >= 0 ? order[index + 1] : undefined;
  const first = index < 0 || above === undefined || isPinned(above) !== pinned;
  const last = index < 0 || below === undefined || isPinned(below) !== pinned;
  const slot = sessionOrder(session);

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    setOpen(false);
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const move = (direction: MoveDirection): void => {
    void act({ kind: 'reorderSession', session, direction, order });
  };

  const item = (
    label: string,
    onClick: () => void,
    disabled: boolean,
    title: string,
  ): React.JSX.Element => (
    <button className="reorder-item" disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  );

  return (
    // The card head focuses the session, so nothing in here may reach it.
    <span className="reorder" ref={wrapRef} onClick={(event) => event.stopPropagation()}>
      <button
        className={`reorder-open${open ? ' showing' : ''}`}
        title={
          `${sessionLabel(session)} ${
            slot === undefined ? 'has no slot' : `is in slot ${slot}`
          }${pinned ? ' and is pinned to the top' : ''} — where it sits in the fleet${
            hidden ? ', which it is currently hidden from' : ''
          }`
        }
        onClick={() => setOpen((was) => !was)}
      >
        ⋮
      </button>
      {open && (
        <span className="reorder-menu">
          <span className="reorder-slot">
            {slot === undefined ? 'no slot' : `slot ${slot}`}
            {pinned && ' · pinned'}
            {hidden && ' · hidden'}
          </span>
          {item(
            'Move to top',
            () => move('top'),
            first,
            pinned ? 'first of the pinned sessions' : 'first below the pinned sessions',
          )}
          {item('Up one', () => move('up'), first, 'swap with the card above')}
          {item('Down one', () => move('down'), last, 'swap with the card below')}
          {item(
            'Move to bottom',
            () => move('bottom'),
            last,
            pinned ? 'last of the pinned sessions' : 'last in the fleet',
          )}
          {/* Divided off too, and above "clear slot" because it is the bigger of
              the two: a pin decides which list the four moves above are about. */}
          <span className="reorder-divider" />
          {item(
            pinned ? 'Unpin' : 'Pin to top',
            () => void act({ kind: 'setSessionPinned', session, pinned: !pinned }),
            false,
            pinned
              ? 'back among the unpinned, at the slot it already has'
              : 'hold it above every unpinned session, whatever they are doing',
          )}
          {/* Divided off: everything above is a position, this one is whether the
              card has one at all. Without a slot it is sorted by what it is
              doing, which is what the panel did before any of this. */}
          <span className="reorder-divider" />
          {item(
            'Clear slot',
            () => void act({ kind: 'clearSessionOrder', session }),
            slot === undefined,
            'drop the number — sorted by what it is doing again',
          )}
          {/* Last, and the only item here that is not about position at all: the
              four moves and the pin are where the card sits, this is whether it
              is on the screen. Both the pin and the slot survive it, so unhiding
              is exactly the way back. */}
          {item(
            hidden ? 'Unhide' : 'Hide',
            () => void act({ kind: 'setSessionHidden', session, hidden: !hidden }),
            false,
            hidden
              ? `back in the fleet, ${pinned ? 'among the pins' : 'at the slot it already has'}`
              : 'out of the fleet, under "hidden" at the bottom — the session keeps running',
          )}
        </span>
      )}
    </span>
  );
}
