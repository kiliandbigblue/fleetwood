import { Fragment } from 'react';

/*
 * A task's name, set as the thing it actually is.
 *
 * It was the platform's UI sans at 600 — the one proportional face in a panel
 * that is otherwise entirely monospace, and a face nobody chose: whatever macOS
 * hands out for `system-ui`. So a group heading read as pasted in from another
 * application, and the panel spoke in two voices for no reason either of them
 * could explain.
 *
 * These names are not prose. Every one of them is a git branch minus its type
 * prefix — `receive-list-cross-dockable-orders` — a machine identifier that you
 * also type at a shell. Mono is what the panel already uses for every other
 * identifier on screen, so the heading joins that voice, and takes its
 * separation from size, weight and full-strength ink instead of from a second
 * family.
 *
 * The identity is in the hyphens. A slug this long is one unbroken token to the
 * eye, and the four or five words inside it are the part you actually read; so
 * the separators give up their ink and keep their width. It costs nothing, it is
 * derived from the data rather than applied to it, and it makes a 43-character
 * name scannable in a 738px column — which no choice of typeface would have
 * done.
 *
 * They are dropped rather than dimmed. Dimmed was the first try, and at title
 * weight a dim hyphen every seven characters does not read as five separators:
 * mono sets them all at one height, at the ink's own mid-line, and five of them
 * across a heading line up into something the eye takes for a strikethrough —
 * the whole fleet looked struck out. The character stays in the DOM so the slug
 * still copies as the branch it is; only the ink goes.
 */
export function Slug({ text }: { text: string }): React.JSX.Element {
  const words = text.split('-');
  return (
    <>
      {words.map((word, i) => (
        // The index is the key because a slug's own repeated words are not
        // unique — `receive-receive-item…` is a real task name.
        <Fragment key={i}>
          {i > 0 && <span className="slug-sep">-</span>}
          {word}
        </Fragment>
      ))}
    </>
  );
}
