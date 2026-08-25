// The leaf module, not the barrel: `@fleetwood/core` re-exports tmux and process
// scanning, which fail the renderer bundle on `node:child_process`.
import { paletteFor } from '@fleetwood/core/theme';
import type { ThemeName } from '@fleetwood/core/theme';

/**
 * Paint one palette onto the document.
 *
 * The property names are the roles verbatim, which is what lets `styles.css`
 * declare `var(--danger)` once and never learn that themes exist. Set on the root
 * element rather than swapping a stylesheet or a `data-theme` attribute, so a
 * theme is data in one file instead of a CSS block per flavour.
 */
export function applyTheme(name: ThemeName): void {
  const { style } = document.documentElement;
  for (const [role, hex] of Object.entries(paletteFor(name))) {
    style.setProperty(`--${role}`, hex);
  }
}
