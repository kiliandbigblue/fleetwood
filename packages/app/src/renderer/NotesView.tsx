import type { CSSProperties, MouseEvent } from 'react';
import type { NoteLine, NoteSpan } from '@fleetwood/core/notesMarkdown';
import { parseNotes } from '@fleetwood/core/notesMarkdown';
import { send } from './api.ts';

interface Props {
  text: string;
  /**
   * A click on a line, with which source line it was. The caller puts a cursor
   * there; absent, the view is only for reading and a click does nothing.
   */
  onLine?: (index: number) => void;
  /** A box ticked, with its source line. Absent, the boxes are drawn but inert. */
  onToggle?: (index: number) => void;
}

/**
 * A note, drawn as the markdown it is written in — see `notesMarkdown.ts`.
 *
 * One block per source line, and the line's index on it, because the two
 * things you do to a drawn note are point at a line — tick this, write here —
 * and each has to find the typed line it came from. That is also why this does
 * not build nested `<ul>`s: the level is a number on the line, and the depth
 * is padding, so a wrapped line hangs under its own first word rather than
 * under the bullet, which is most of what makes a nested list legible at 11px.
 *
 * Runs of blank lines fold to one, and the blanks at either end go. In the
 * textarea they are room to type in; drawn, they are room for nothing.
 */
export function NotesView({ text, onLine, onToggle }: Props): React.JSX.Element {
  const lines = fold(parseNotes(text));

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onLine) return;
    // Between the lines, or under the last one, is the end of the note — where
    // the next line goes. A blank line is its own place, kept for that reason.
    const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
    const index = hit?.dataset.line;
    onLine(index === undefined ? Number.MAX_SAFE_INTEGER : Number(index));
  };

  return (
    <div className={`md${onLine ? ' md-live' : ''}`} onClick={onClick}>
      {lines.map((line) => (
        <Line key={line.index} line={line} onToggle={onToggle} />
      ))}
    </div>
  );
}

function fold(lines: NoteLine[]): NoteLine[] {
  const out: NoteLine[] = [];
  for (const line of lines) {
    if (line.kind === 'blank' && (out.length === 0 || out[out.length - 1]!.kind === 'blank')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'blank') out.pop();
  return out;
}

function Line({ line, onToggle }: { line: NoteLine; onToggle?: (index: number) => void }): React.JSX.Element {
  const style = { '--level': line.level } as CSSProperties;

  if (line.kind === 'blank') return <div className="md-blank" data-line={line.index} />;

  if (line.kind === 'heading') {
    return (
      <div className={`md-h md-h${line.level}`} data-line={line.index}>
        <Spans spans={line.spans} />
      </div>
    );
  }

  if (line.kind === 'text') {
    return (
      <div className="md-p" style={style} data-line={line.index}>
        <Spans spans={line.spans} />
      </div>
    );
  }

  return (
    <div
      className={`md-item${line.check === 'done' ? ' done' : ''}`}
      style={style}
      data-line={line.index}
      data-level={line.level}
    >
      {line.check ? (
        // The box is the text — `[ ]` or `[x]` on that line — so ticking it is
        // an edit, made by whoever owns the text. See `toggleCheckbox`.
        <button
          type="button"
          className="md-box"
          role="checkbox"
          aria-checked={line.check === 'done'}
          disabled={!onToggle}
          title={line.check === 'done' ? 'done — click to reopen' : 'to do — click to tick off'}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.(line.index);
          }}
        >
          {line.check === 'done' && (
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m2.5 6.5 2.3 2.3 4.7-5.3" />
            </svg>
          )}
        </button>
      ) : line.marker ? (
        <span className="md-marker md-num">{line.marker}</span>
      ) : (
        <span className="md-marker md-bullet" aria-hidden="true" />
      )}
      <span className="md-body">
        <Spans spans={line.spans} />
      </span>
    </div>
  );
}

function Spans({ spans }: { spans: NoteSpan[] }): React.JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'code':
            return <code key={i}>{span.text}</code>;
          case 'strong':
            return <strong key={i}>{span.text}</strong>;
          case 'em':
            return <em key={i}>{span.text}</em>;
          case 'link':
            return (
              <a
                key={i}
                href={span.href}
                title={span.href}
                onClick={(event) => {
                  // The panel is not a browser: a link leaves through the shell,
                  // and the click does not also land on the line under it.
                  event.preventDefault();
                  event.stopPropagation();
                  void send({ kind: 'openExternal', url: span.href ?? span.text });
                }}
              >
                {span.text}
              </a>
            );
          default:
            return span.text;
        }
      })}
    </>
  );
}
