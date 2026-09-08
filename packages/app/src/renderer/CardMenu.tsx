import { useEffect, useRef, useState } from 'react';
import { isHidden, isPinned, sessionLabel, sessionOrder } from '@fleetwood/core/sessionOrder';
import type { MoveDirection } from '@fleetwood/core/sessionOrder';
import { Icon } from './Icon.tsx';
import { send } from './api.ts';
import { useDismiss } from './useDismiss.ts';

/** One line in a card's menu. */
export interface MenuItem {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Two steps, for the items that delete work. The menu is the timer. */
  confirm?: boolean;
}

interface Props {
  /**
   * The tmux session this card is showing, when it has one.
   *
   * Without one the menu is the card's actions and nothing else: the slot lives
   * on the session name, so a dormant task has nowhere to keep a position.
   */
  session?: string;
  /** Session names in the order the panel is drawing them right now. */
  order?: string[];
  /** What this card does — the chips that used to sit in its header. */
  actions: MenuItem[];
  onResult: (message: string, ok: boolean) => void;
}

/**
 * Everything you can do to a card, behind one dot column.
 *
 * Three groups, in order of consequence: what the card makes, where it sits,
 * and what takes it away. Position only appears for a card with a session to
 * hold one — the slot lives on the tmux session's name, so a dormant task has
 * nowhere to keep one. There is no "up one": two clicks to move a card one
 * place is worse than the arrows this replaced.
 *
 * The moves are bounded by the card's own tier, which is why "move to top" can
 * be inert on a card that is not at the top of the panel: a pinned short-list
 * sits above, and the top this card has is the top of the unpinned list.
 */
export function CardMenu({ session, order, actions, onResult }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /** Which `confirm` item is armed, by label. One at a time, cleared on close. */
  const [armed, setArmed] = useState<string>();
  const wrapRef = useRef<HTMLSpanElement>(null);
  useDismiss(wrapRef, open, () => setOpen(false));
  useEffect(() => {
    if (!open) setArmed(undefined);
  }, [open]);

  const pinned = session !== undefined && isPinned(session);
  const hidden = session !== undefined && isHidden(session);
  const slot = session === undefined ? undefined : sessionOrder(session);
  const positioned = session !== undefined && order !== undefined;
  const index = positioned ? order.indexOf(session) : -1;
  // The ends of this card's tier, not of the panel: the moves stop at the pins.
  const above = index > 0 ? order?.[index - 1] : undefined;
  const below = index >= 0 ? order?.[index + 1] : undefined;
  const first = index < 0 || above === undefined || isPinned(above) !== pinned;
  const last = index < 0 || below === undefined || isPinned(below) !== pinned;

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    setOpen(false);
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const move = (direction: MoveDirection): void => {
    if (session === undefined || order === undefined) return;
    void act({ kind: 'reorderSession', session, direction, order });
  };

  const row = (item: MenuItem): React.JSX.Element => {
    const arming = item.confirm === true && armed !== item.label;
    return (
      <button
        key={item.label}
        className={`menu-item${item.danger === true ? ' danger' : ''}`}
        role="menuitem"
        disabled={item.disabled === true}
        title={item.title}
        onClick={() => {
          if (arming) {
            setArmed(item.label);
            return;
          }
          setOpen(false);
          item.onClick();
        }}
      >
        {arming ? item.label : item.confirm === true ? `${item.label} — sure?` : item.label}
      </button>
    );
  };

  const moveItem = (label: string, direction: MoveDirection, disabled: boolean, title: string): MenuItem => ({
    label,
    title,
    disabled,
    onClick: () => move(direction),
  });

  return (
    // The card head focuses the session, so nothing in here may reach it.
    <span className="card-menu" ref={wrapRef} onClick={(event) => event.stopPropagation()}>
      <button
        className={`menu-open${open ? ' showing' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          session === undefined
            ? 'what this task can do'
            : `${sessionLabel(session)} ${
                slot === undefined ? 'has no slot' : `is in slot ${slot}`
              }${pinned ? ' and is pinned to the top' : ''} — what this card can do, and where it sits${
                hidden ? ', which is currently out of the fleet' : ''
              }`
        }
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="dots" />
      </button>
      {open && (
        <span className="menu-sheet" role="menu">
          {actions.filter((item) => !item.danger).map(row)}

          {positioned && (
            <>
              {/* A heading, not a readout: which slot this card is in is on the
                  trigger's tooltip, and having it here as well put the card's
                  current state where a group title goes. */}
              <span className="menu-label" role="presentation">
                position
              </span>
              {row(
                moveItem(
                  'move to top',
                  'top',
                  first,
                  pinned ? 'first of the pinned sessions' : 'first below the pinned sessions',
                ),
              )}
              {row(
                moveItem(
                  'move to bottom',
                  'bottom',
                  last,
                  pinned ? 'last of the pinned sessions' : 'last in the fleet',
                ),
              )}
              {row({
                label: pinned ? 'unpin' : 'pin to top',
                title: pinned
                  ? 'back among the unpinned, at the slot it already has'
                  : 'hold it above every unpinned session, whatever they are doing',
                onClick: () => void act({ kind: 'setSessionPinned', session, pinned: !pinned }),
              })}
              {row({
                label: 'clear slot',
                title: 'drop the number — sorted by what it is doing again',
                disabled: slot === undefined,
                onClick: () => void act({ kind: 'clearSessionOrder', session }),
              })}
            </>
          )}

          {/* The two ways a card leaves the list, together and last: hiding and
              archiving are the same intent at two strengths. */}
          {(positioned || actions.some((item) => item.danger === true)) && (
            <span className="menu-divider" role="separator" />
          )}
          {positioned &&
            row({
              label: hidden ? 'unhide' : 'hide',
              title: hidden
                ? `back in the fleet, ${pinned ? 'among the pins' : 'at the slot it already has'}`
                : 'out of the fleet, under "hidden" at the bottom — the session keeps running',
              onClick: () => void act({ kind: 'setSessionHidden', session, hidden: !hidden }),
            })}
          {actions.filter((item) => item.danger === true).map(row)}
        </span>
      )}
    </span>
  );
}
