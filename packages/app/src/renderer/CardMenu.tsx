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
  /** The list key that does the same from the card, without the menu. */
  shortcut?: string;
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
 * place is worse than the arrows this replaced. From the keyboard it is `J`/`K`
 * on the card itself, and each move here names its own key — the sheet is where
 * you learn them, and after that you no longer need to open it.
 *
 * Where it sits is one row, `arrange`, that opens onto its four moves in the
 * same sheet. They were four rows of their own, which took a task's menu to
 * eleven — the things you open a menu for sat among the ones you use once a
 * week, and the list was too long to take in before choosing. Arranging is
 * the rare errand, so it is the one that costs a click.
 *
 * The moves are bounded by the card's own tier, which is why "move to top" can
 * be inert on a card that is not at the top of the panel: a pinned short-list
 * sits above, and the top this card has is the top of the unpinned list.
 */
export function CardMenu({ session, order, actions, onResult }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /** Which `confirm` item is armed, by label. One at a time, cleared on close. */
  const [armed, setArmed] = useState<string>();
  /** Whether the sheet is showing the position moves in place of the actions. */
  const [arranging, setArranging] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLSpanElement>(null);
  useDismiss(wrapRef, open, () => setOpen(false));
  /*
   * Whether the sheet was open on the last render.
   *
   * The effect below runs on mount too, with `open` false and focus on `body`
   * because nothing has taken it yet — which is exactly what "focus went down
   * with the sheet" looks like. Without this every card pulled focus to its ⋮
   * as it appeared, so the panel opened with a focus ring on the first card.
   * Only a sheet that was open can hand focus back.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!open) {
      setArmed(undefined);
      setArranging(false);
    }
    if (!closing) return;
    // Back to the ⋮ it came from, but only if focus went down with the sheet
    // — the browser drops it on `body` when the focused row unmounts. A menu
    // closed by a click elsewhere must not pull focus back from that click.
    const lost = document.activeElement === document.body;
    if (lost || wrapRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
  }, [open]);
  /*
   * Focus the first live row whenever the sheet opens or swaps its rows.
   *
   * A `role="menu"` promises the keyboard it can be driven: opened, it is where
   * focus is, and the arrows move through it. Without this it was a list of
   * buttons behind a label that said otherwise — the rows were reachable only
   * by tabbing through the rest of the card first.
   */
  useEffect(() => {
    if (open) sheetRef.current?.querySelector<HTMLButtonElement>('.menu-item:enabled')?.focus();
  }, [open, arranging]);

  /** Up and down the live rows, wrapping, as a menu does. */
  const onSheetKey = (event: React.KeyboardEvent<HTMLSpanElement>): void => {
    const rows = [...(sheetRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item:enabled') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const to = (index: number): void => {
      event.preventDefault();
      rows[(index + rows.length) % rows.length]?.focus();
    };
    if (event.key === 'Escape') {
      // Handled here rather than left to `useDismiss`, because the line below
      // stops the event before it could reach the document.
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') to(at + 1);
    else if (event.key === 'ArrowUp') to(at - 1);
    else if (event.key === 'Home') to(0);
    else if (event.key === 'End') to(rows.length - 1);
    else if (event.key === 'ArrowLeft' && arranging) {
      event.preventDefault();
      setArranging(false);
    } else if (event.key === 'ArrowRight' && document.activeElement?.classList.contains('menu-more')) {
      event.preventDefault();
      setArranging(true);
    }
    // The list's own keys must not act on the card behind an open menu.
    event.stopPropagation();
  };

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
        {item.shortcut !== undefined && (
          <kbd className="menu-key" aria-hidden="true">
            {item.shortcut}
          </kbd>
        )}
      </button>
    );
  };

  const moveItem = (
    label: string,
    direction: MoveDirection,
    disabled: boolean,
    title: string,
    shortcut: string,
  ): MenuItem => ({
    label,
    title,
    disabled,
    shortcut,
    onClick: () => move(direction),
  });

  return (
    // The card head focuses the session, so nothing in here may reach it.
    <span className="card-menu" ref={wrapRef} onClick={(event) => event.stopPropagation()}>
      <button
        ref={triggerRef}
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
        <span className="sr-only">{session === undefined ? 'task actions' : `actions for ${sessionLabel(session)}`}</span>
      </button>
      {open && (
        <span className="menu-sheet" role="menu" ref={sheetRef} onKeyDown={onSheetKey}>
          {arranging && positioned ? (
            <>
              <button className="menu-item menu-back" role="menuitem" onClick={() => setArranging(false)}>
                <Icon name="chevron" />
                arrange
              </button>
              {row(
                moveItem(
                  'move to top',
                  'top',
                  first,
                  pinned ? 'first of the pinned sessions' : 'first below the pinned sessions',
                  't',
                ),
              )}
              {row(
                moveItem(
                  'move to bottom',
                  'bottom',
                  last,
                  pinned ? 'last of the pinned sessions' : 'last in the fleet',
                  'b',
                ),
              )}
              {row({
                label: pinned ? 'unpin' : 'pin to top',
                title: pinned
                  ? 'back among the unpinned, at the slot it already has'
                  : 'hold it above every unpinned session, whatever they are doing',
                shortcut: 'p',
                onClick: () => void act({ kind: 'setSessionPinned', session, pinned: !pinned }),
              })}
              {row({
                label: 'clear slot',
                title: 'drop the number — back to the default order: sessions with agents first, then tmux order',
                disabled: slot === undefined,
                onClick: () => void act({ kind: 'clearSessionOrder', session }),
              })}
            </>
          ) : (
            <>
              {actions.filter((item) => !item.danger).map(row)}

              {positioned && (
                <button
                  className="menu-item menu-more"
                  role="menuitem"
                  aria-haspopup="menu"
                  title={`move, pin or clear the slot — ${
                    slot === undefined ? 'no slot yet' : `slot ${slot}`
                  }${pinned ? ', pinned' : ''}`}
                  onClick={() => setArranging(true)}
                >
                  arrange
                  <Icon name="chevron" />
                </button>
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
            </>
          )}
        </span>
      )}
    </span>
  );
}
