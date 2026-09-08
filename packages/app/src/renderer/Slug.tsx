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
 * the separators drop a tier and the words keep the ink. It costs nothing, it is
 * derived from the data rather than applied to it, and it makes a 43-character
 * name scannable in a 738px column — which no choice of typeface would have
 * done.
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
