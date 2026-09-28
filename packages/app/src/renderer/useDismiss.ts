import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Close a popover on an outside click or Escape.
 *
 * Shared by the popovers — the theme picker, the quota expansion and each
 * card's menu — because both are anchored to a rail button with no backdrop under
 * them, and a popover you can only dismiss by clicking its own button is the
 * thing that makes a panel feel stuck.
 *
 * The click listener is registered in the capture phase so a click on any *other*
 * control closes this before that control acts: pressing refresh while the theme
 * menu is open should refresh, not just dismiss.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /*
       * This Escape is spent. The panel's own Escape — the way out of an opened
       * task — listens on `window`, which the event reaches after `document`, so
       * without this one press closed the popover *and* the task behind it.
       * Escape means the innermost thing showing, and that is this.
       */
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}
