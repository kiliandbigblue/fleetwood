/**
 * The notes folded to one line, for the drawer's closed state and `fw notes`.
 *
 * The first line that says anything, plus how many there are — enough to tell
 * whether you wrote something tonight without opening it, which is the whole of
 * what a closed drawer has to say.
 *
 * Its own file, apart from the reader, for the reason `contextFormat.ts` is: the
 * renderer imports this leaf, and the reader would drag `fs` into its bundle.
 */
export function describeNotes(text: string): { head: string; lines: number } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // A markdown heading is the note's own title; the marker is noise in one line.
  const head = (lines[0] ?? '').replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
  return { head, lines: lines.length };
}
