/**
 * The notes, read as the markdown they are written in.
 *
 * Both notes — yours in the drawer, a task's on its card — are typed as
 * markdown: `#` for the day, `- ` for the things, `- [ ]` for the ones still
 * to do, four spaces under one for the parts of it. Shown back as the raw text
 * they read as source, and the shape that was in the writer's head — this is
 * under that, these three are done — was the reader's to rebuild from the
 * indentation and the brackets. So the panel draws them as what they say.
 *
 * Line by line, on purpose. A note is a list of lines each saying one thing,
 * not an article: a checkbox is a line, a heading is a line, and the one thing
 * the renderer must be able to do is point back at the line it drew — to tick
 * its box, or to put the cursor on it. So every line keeps its `index` into
 * the source, and nothing here spans lines. Tables, fenced code, block quotes
 * and setext headings are not read: nobody writes them at 18:55.
 *
 * Its own file, apart from the reader, for the reason `notesFormat.ts` is: the
 * renderer imports this leaf, and the reader would drag `fs` into its bundle.
 */

/** One run of inline text, and what it is. */
export interface NoteSpan {
  kind: 'text' | 'code' | 'strong' | 'em' | 'link';
  text: string;
  /** Where a `link` goes — the `(url)` half, or the bare URL itself. */
  href?: string;
}

/** One line of the note, with what kind of line it is. */
export interface NoteLine {
  /** Into the source split on `\n`, so a click on this line can find its text. */
  index: number;
  kind: 'blank' | 'heading' | 'item' | 'text';
  /**
   * A heading's rank, 1–6. An item's nesting, from 0. A plain line's nesting,
   * which is how far in it sat — the same reckoning an item gets, so a sentence
   * written under a bullet draws under it.
   */
  level: number;
  /** An item's box, when it has one. */
  check?: 'open' | 'done';
  /** An ordered item's own number, `1.` — undefined on a bullet. */
  marker?: string;
  spans: NoteSpan[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^(?:[-*+]|\d{1,3}[.)])\s+/;
const ORDERED = /^(\d{1,3}[.)])\s+/;
const CHECK = /^\[( |x|X)\]\s*/;

/** Leading width in columns, a tab counting for four. */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * Read the note into lines.
 *
 * Nesting is read the way a markdown parser reads it, off a stack of the
 * indents seen so far rather than off a fixed step: a line further in than the
 * one above is a level down, a line further out pops back to whichever level
 * it lines up with. So two-space, four-space and tabbed notes all come out
 * with the shape they were typed in, and a note that mixes them by accident
 * still reads.
 */
export function parseNotes(text: string): NoteLine[] {
  const lines = text.split('\n');
  const out: NoteLine[] = [];
  /** The indents of the items open above this line, outermost first. */
  const stack: number[] = [];

  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      out.push({ index, kind: 'blank', level: 0, spans: [] });
      return;
    }

    const heading = HEADING.exec(trimmed);
    if (heading && indentOf(raw) < 4) {
      // A heading is a fresh start; nothing after it is under what was before.
      stack.length = 0;
      out.push({ index, kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!.trim()) });
      return;
    }

    const indent = indentOf(raw);
    // Back out to the level this line lines up with.
    while (stack.length > 0 && indent < stack[stack.length - 1]!) stack.pop();

    const item = ITEM.exec(trimmed);
    if (item) {
      if (stack.length === 0 || indent > stack[stack.length - 1]!) stack.push(indent);
      const level = stack.length - 1;
      let rest = trimmed.slice(item[0].length);
      const marker = ORDERED.exec(trimmed)?.[1];
      const check = CHECK.exec(rest);
      if (check) rest = rest.slice(check[0].length);
      const line: NoteLine = { index, kind: 'item', level, spans: parseInline(rest) };
      if (check) line.check = check[1] === ' ' ? 'open' : 'done';
      if (marker) line.marker = marker;
      out.push(line);
      return;
    }

    // Prose. Under the item it sits in past, on that item's own rail when it
    // lines up with the marker, and back on the margin — list over — when it
    // is out at the edge.
    if (stack.length > 0 && indent <= stack[0]!) stack.length = 0;
    const level = stack.length === 0 ? 0 : indent > stack[stack.length - 1]! ? stack.length : stack.length - 1;
    out.push({ index, kind: 'text', level, spans: parseInline(trimmed) });
  });

  return out;
}

/*
 * What can be marked inside a line: `code`, **strong**, *em* / _em_, a
 * [label](url), and a bare URL, which is what a note actually holds — the
 * loom, the PR, the doc. Anything unpaired is text: a stray asterisk is a
 * stray asterisk, not the start of emphasis that never ends.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]+?\S)\*\*|(?<![\w*])[*_](?=\S)([^*_]+?\S)[*_](?![\w*])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function parseInline(text: string): NoteSpan[] {
  const spans: NoteSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) spans.push({ kind: 'text', text: text.slice(last, at) });
    const [whole, , code, strong, em, label, href, url] = match;
    if (code !== undefined) spans.push({ kind: 'code', text: code.trim() });
    else if (strong !== undefined) spans.push({ kind: 'strong', text: strong });
    else if (em !== undefined) spans.push({ kind: 'em', text: em });
    else if (label !== undefined && href !== undefined) spans.push({ kind: 'link', text: label, href });
    else if (url !== undefined) spans.push({ kind: 'link', text: url, href: url });
    last = at + whole.length;
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) });
  return spans;
}

/**
 * Tick or untick the box on line `index`, and hand back the whole note.
 *
 * The text is the truth and the box is a view of it, so a click edits the text
 * — `[ ]` to `[x]` and back — and the panel re-reads. Nothing else on the line
 * moves; the cursor of whoever is in an editor on the same file lands where it
 * was. A line without a box comes back as the note it was.
 */
export function toggleCheckbox(text: string, index: number): string {
  const lines = text.split('\n');
  const line = lines[index];
  if (line === undefined) return text;
  const match = /^(\s*(?:[-*+]|\d{1,3}[.)])\s+)\[( |x|X)\]/.exec(line);
  if (!match) return text;
  const box = match[2] === ' ' ? '[x]' : '[ ]';
  lines[index] = `${match[1]}${box}${line.slice(match[0].length)}`;
  return lines.join('\n');
}

/** Where line `index` starts in the text, for putting a cursor on it. */
export function offsetOfLine(text: string, index: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < index && i < lines.length; i += 1) offset += lines[i]!.length + 1;
  return Math.min(offset, text.length);
}
