import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Close a popover on an outside click or Escape.
 *
 * Shared by the two popovers in the rails — the theme picker and the quota
 * expansion — because both are anchored to a rail button with no backdrop under
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
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}
