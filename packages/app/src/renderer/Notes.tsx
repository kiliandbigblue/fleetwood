import { useCallback, useEffect, useRef, useState } from 'react';
import { describeNotes } from '@fleetwood/core/notesFormat';
import { Icon } from './Icon.tsx';
import { send } from './api.ts';

/** How long after the last keystroke the file is written. */
const SAVE_AFTER_MS = 500;

interface Props {
  /** What is on disk. The textarea reads `draft`, never this — see below. */
  notes: string;
  open: boolean;
  onToggle: () => void;
  onResult: (message: string, ok: boolean) => void;
}

/**
 * Your notes: a drawer at the foot of the panel, on every tab.
 *
 * This is the end-of-day brain dump. It was a Raycast note, and the reason it
 * moved is that writing "where am I on each thing" needs the things in view —
 * so it is not a tab, which would replace the fleet with a box, and it is not
 * on the power tab, which is one card about the machine. It sits under whatever
 * list you are reading and stays there while you scroll it; the shutdown
 * warning opens it, because that is the moment it is for.
 *
 * Saved as you type rather than on ⌘↵, unlike a task's note. That one is a
 * field on a card you open and close; this is a scratchpad you leave open, and
 * a scratchpad with a save button is one you lose an evening's worth of when
 * the machine goes down at 19:00 — which is the exact thing this panel does.
 *
 * The text is held here and not read off the snapshot while you are in it: a
 * snapshot lands every second, and a textarea bound to it would have the
 * cursor jump to the end each time. Disk wins only when nothing is pending —
 * you are not typing and no save is still out — which is what lets a line
 * added in an editor land without a relaunch.
 */
export function Notes({ notes, open, onToggle, onResult }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(notes);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Saves still out. A poll answered before one lands would show stale text. */
  const inFlight = useRef(0);
  /** The text last handed to a save, or last taken off disk — `draft` when nothing is pending. */
  const settled = useRef(notes);
  const field = useRef<HTMLTextAreaElement>(null);

  const save = useCallback(
    (text: string): void => {
      timer.current = undefined;
      if (text === settled.current) return;
      settled.current = text;
      inFlight.current += 1;
      void send({ kind: 'setNotes', notes: text })
        .then((result) => {
          // Silent when it worked: a toast per keystroke is noise, and the file
          // being there is its own confirmation. Loud when it did not, because
          // the alternative is finding out in the morning.
          if (!result.ok) onResult(result.detail, false);
        })
        .finally(() => {
          inFlight.current -= 1;
        });
    },
    [onResult],
  );

  /** Write now rather than at the timer, for blur and close. */
  const flush = useCallback((): void => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    save(draft);
  }, [draft, save]);

  const onChange = (text: string): void => {
    setDraft(text);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(text), SAVE_AFTER_MS);
  };

  // Disk wins when nothing here is ahead of it.
  useEffect(() => {
    if (focused || timer.current !== undefined || inFlight.current > 0) return;
    if (notes === settled.current) return;
    settled.current = notes;
    setDraft(notes);
  }, [notes, focused]);

  // The cursor goes to the end, where the next line is written — not to the
  // start, which is where a fresh textarea puts it and where yesterday's note is.
  useEffect(() => {
    if (!open) return;
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [open]);

  // Closing is not cancelling: whatever was typed goes to disk on the way out.
  // The textarea leaves with the drawer, and a blur on an element being removed
  // is not something to rely on — so the focus flag is dropped here as well.
  useEffect(() => {
    if (open) return;
    setFocused(false);
    flush();
  }, [open, flush]);

  const { head, lines } = describeNotes(draft);

  return (
    <div className={`notes${open ? ' open' : ''}`}>
      <button
        className="notes-toggle"
        aria-expanded={open}
        onClick={onToggle}
        title={open ? 'fold the notes away (⌘N)' : 'your notes — kept in ~/.fleetwood/notes.md (⌘N)'}
      >
        <span className="notes-caret" aria-hidden="true">
          <Icon name="chevron" />
        </span>
        notes
        {/* Folded, the bar says what is in the note; opened, the note is right
            below it and the bar says only what it is. */}
        {!open && lines > 0 && (
          <>
            <span className="notes-head">{head}</span>
            {lines > 1 && <span className="notes-count">+{lines - 1}</span>}
          </>
        )}
        {!open && lines === 0 && <span className="notes-head empty">where you are, for tomorrow</span>}
        <span className="key">⌘N</span>
      </button>

      {open && (
        <>
          <textarea
            ref={field}
            className="notes-field"
            value={draft}
            spellCheck={false}
            placeholder={'where you are, for tomorrow —\nwhat each task is waiting on, what to say to whom, what you nearly forgot'}
            onChange={(event) => onChange(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              flush();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // Closes the drawer and stops there: escape means the innermost
                // thing open, and `App` would otherwise also close a focused
                // task behind it.
                event.stopPropagation();
                onToggle();
              }
            }}
          />
          <div className="notes-hint">saved as you type · ~/.fleetwood/notes.md · esc closes</div>
        </>
      )}
    </div>
  );
}
