// The leaf module, not the barrel: `@fleetwood/core` re-exports tmux and process
// scanning, which fail the renderer bundle on `node:child_process`.
import { paletteFor, withAlpha } from '@fleetwood/core/theme';
import type { Palette, ThemeName } from '@fleetwood/core/theme';

/**
 * The roles that are the window's own substance, and so the ones that thin out.
 *
 * Only these two. `edge` is a border and the rest are ink: made translucent they
 * would let the desktop show *through the text*, which is illegible rather than
 * pretty. Card fills derived from these — `color-mix(… var(--panel))` — inherit
 * the alpha for free, so a card still reads as a layer over the window at any
 * setting instead of a solid slab on a see-through one.
 */
const TRANSLUCENT: ReadonlyArray<keyof Palette> = ['bg', 'panel'];

/**
 * Paint one palette onto the document, at a given background opacity.
 *
 * The property names are the roles verbatim, which is what lets `styles.css`
 * declare `var(--danger)` once and never learn that themes exist. Set on the root
 * element rather than swapping a stylesheet or a `data-theme` attribute, so a
 * theme is data in one file instead of a CSS block per flavour.
 *
 * The opacity rides along here rather than in a separate `--alpha` property that
 * the CSS would have to compose: the two surfaces are emitted as `rgb(… / a)`
 * already mixed, so nothing below `:root` changes and every derived fill picks
 * the alpha up on its own.
 */
export function applyTheme(name: ThemeName, bgOpacity: number): void {
  const { style } = document.documentElement;
  const palette = paletteFor(name);
  for (const [role, hex] of Object.entries(palette)) {
    const translucent = TRANSLUCENT.includes(role as keyof Palette);
    style.setProperty(`--${role}`, translucent ? withAlpha(hex, bgOpacity) : hex);
  }
  /*
   * The one exception, for the one surface that must not thin out: the theme
   * popover. It is the only floating thing here with no dimming backdrop under
   * it, and it is where the slider lives — a control you cannot read at the
   * setting it is applying is a control you cannot use to get back.
   */
  style.setProperty('--panel-solid', palette.panel);
}
