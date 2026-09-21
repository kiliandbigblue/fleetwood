import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

interface Props {
  open: boolean;
  onToggle: () => void;
  /** The one word on the door: `hidden`, `notes`. */
  label: string;
  title: string;
  /**
   * What the door says about what is behind it — a count, a first line. Drawn
   * after the label, in reading order, and only the caller knows whether it
   * should still be said once the drawer is open.
   */
  summary?: ReactNode;
  /** Pushed to the far end of the door: a key cap, nothing that carries meaning. */
  trailing?: ReactNode;
  /** The drawer itself, mounted only while it is open. */
  children?: ReactNode;
}

/**
 * A drawer at the foot of the panel: a door, and what is behind it.
 *
 * Two of these sit between the list and the bottom rail — the hidden sessions
 * and the notes — and they are one control because they are one idea: a thing
 * deliberately kept out of the list, with a row that says what it is and how
 * much of it there is, and a quarter turn of the caret to open it. The hidden
 * group was the first and lived *in* the list, held to its foot with
 * `margin-top: auto`; when the notes arrived as a strip outside the scroll, the
 * two doors were a hairline apart and drawn two different ways. Now the one
 * component draws both, so anything either learns the other has.
 *
 * Outside the scroll, so a door is where you left it whether the list above is
 * three cards or thirty. What opens under it is capped to under half the window
 * and scrolls on its own — the list keeps the rest.
 */
export function Drawer({ open, onToggle, label, title, summary, trailing, children }: Props): React.JSX.Element {
  return (
    <div className={`drawer${open ? ' open' : ''}`}>
      <button className="drawer-toggle" aria-expanded={open} onClick={onToggle} title={title}>
        <span className="drawer-caret" aria-hidden="true">
          <Icon name="chevron" />
        </span>
        {label}
        {summary}
        {trailing && <span className="drawer-trailing">{trailing}</span>}
      </button>
      {open && children}
    </div>
  );
}
