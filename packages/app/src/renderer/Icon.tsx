/**
 * The three control glyphs in the top rail, as paths rather than characters.
 *
 * Status marks stay text — `✋`, `▶`, `○` are shared with the tray title, which
 * can only draw a string, and a fleet count has to say the same thing in both
 * places. Controls have no such obligation and were paying for it: `⇧` is the
 * shift key, not "keep above", and no codepoint means "always on top". Chromium
 * draws inline SVG for free, so the honest fix is to draw them.
 *
 * Sized in `em` so they follow the button's font-size, and stroked in
 * `currentColor` so hover and the `on` state are the button's business.
 *
 * `pin` is neither a control nor a status mark, and it is here for the reason
 * the controls are: it was `📌`, the one raster object in a panel drawn entirely
 * in hairlines and text, and the only thing on screen with colours of its own —
 * so it pulled the eye to the least urgent fact on the card. Nothing shares it
 * with the tray, so drawing it costs nothing.
 */
interface Props {
  name: 'above' | 'contrast' | 'refresh' | 'pin' | 'plus' | 'chevron' | 'dots';
}

export function Icon({ name }: Props): React.JSX.Element {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'above' && (
        <>
          <path d="M5 3.5h14" />
          <path d="m18 13.5-6-6-6 6" />
          <path d="M12 7.5v13" />
        </>
      )}
      {/* A disc half filled: the one glyph here that was already right, kept as
          a shape so it scales with the others instead of riding font metrics. */}
      {name === 'contrast' && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
        </>
      )}
      {/* Filled, not stroked. At 10px this file's 1.9 stroke in a 24-unit box
          is under a pixel wide and reads as a smudge on a translucent panel, and
          a pin that small has no interior worth outlining anyway. */}
      {name === 'pin' && (
        <path
          d="M9 3h6a1 1 0 0 1 0 2h-.6l.8 5.2 2.3 2.6a1 1 0 0 1-.7 1.7H13v7.8a1 1 0 0 1-2 0V14.5H7.2a1 1 0 0 1-.7-1.7l2.3-2.6L9.6 5H9a1 1 0 0 1 0-2Z"
          fill="currentColor"
          stroke="none"
        />
      )}
      {/* Points right; the drawer that owns it turns it a quarter when it opens.
          A `▸` was here first and is three pixels of ink in this face — the same
          reason `⇧` and `⤢` are drawn rather than typed. */}
      {name === 'chevron' && <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />}
      {/* A card's menu. Three discs rather than `⋮`, which is thin in most UI
          faces and sits off the row's optical centre. */}
      {name === 'dots' && (
        <>
          <circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
        </>
      )}
      {name === 'plus' && (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      )}
      {name === 'refresh' && (
        <>
          <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
          <path d="M20.7 4.2v4.6h-4.6" />
        </>
      )}
    </svg>
  );
}
