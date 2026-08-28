/**
 * Keep `--zoom` on the document equal to the window's zoom factor.
 *
 * Everything in this panel is CSS px, so ⌘+/⌘- scales all of it together — which
 * is the point, and is fine for every measurement that only relates to other
 * measurements in the panel. It is wrong for exactly one: the top rail's left
 * inset, which clears macOS's traffic lights. Those are native chrome, fixed in
 * points, and no zoom touches them — so a 78px inset becomes 62pt of clearance
 * at 80% zoom and `FLEET` slides in under the green button.
 *
 * With the factor on the document, that one measurement can divide by it and
 * stay physically put (`calc(78px / var(--zoom))`) while everything else keeps
 * scaling.
 *
 * There is no zoom event to listen to. Both ways of zooming change the viewport,
 * so the viewport's own events are the signal: `resize` on the window for the
 * menu's zoom commands, and `visualViewport` for pinch — read the real factor on
 * each rather than trying to track it.
 */
export function watchZoom(): () => void {
  const apply = (): void => {
    const factor = window.fleetwood?.zoomFactor?.() ?? 1;
    // A factor of 0 would divide the inset into infinity and push the rail's
    // contents out of the window.
    const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
    document.documentElement.style.setProperty('--zoom', String(safe));
  };

  apply();
  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
  return () => {
    window.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('resize', apply);
  };
}
