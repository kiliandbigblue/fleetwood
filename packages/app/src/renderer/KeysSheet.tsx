import { useEffect, useRef } from 'react';

/*
 * Every key the fleet answers to, and every mark it draws, on one sheet.
 *
 * The panel teaches itself through tooltips, which is right for a mark you are
 * pointing at and useless for one you have never thought to point at — the
 * glyphs on a row and the keys on a card had no page where they were all said
 * at once. This is that page, behind `?`, and it is short on purpose: a line per
 * thing, in the same marks the list draws, so the sheet looks like the list it
 * is explaining.
 */

/** A key and what it does, in the list's own words. */
const KEYS: ReadonlyArray<[string, string]> = [
  ['j  k', 'down and up the cards'],
  ['n', 'the next card that needs you'],
  ['enter', 'go to the focused card in tmux'],
  ['1 – 9', 'answer its prompt, as the terminal numbers it'],
  ['a  d', 'the approve and deny answers'],
  ['m', 'its menu — arrows to move, esc to close'],
  ['→  ←', 'unfold and fold a parked task'],
  ['⌘K', 'jump to any tmux session'],
  ['⌘T', 'new task'],
  ['⌘N', 'your notes'],
  ['⌘R', 'refresh everything'],
  ['esc', 'close what is on top, then leave an opened task'],
];

/** A mark, drawn by the class the list draws it with, and what it says. */
const MARKS: ReadonlyArray<{ mark: React.JSX.Element; says: string }> = [
  { mark: <span className="attached-dot sev-danger" />, says: 'an agent here is stopped on a permission prompt' },
  { mark: <span className="attached-dot sev-ok" />, says: 'an agent here is working — filled: you are attached' },
  { mark: <span className="attached-dot sev-quiet detached" />, says: 'every agent here is idle' },
  { mark: <span className="task-status-dot task-status-wip" />, says: 'a parked task, and how far along it is — the ring fills as it lands' },
  { mark: <span className="nested">⤶</span>, says: 'an agent another agent spawned' },
  { mark: <span className="nested">⇢</span>, says: 'runs in the claude daemon, not in the pane' },
  { mark: <span className="subagents">+2</span>, says: 'subagents running under it' },
  { mark: <span className="context-fig warn">312k</span>, says: 'context the next turn re-reads — gold, then red, as it gets costly' },
  { mark: <span className="task-pr-via">⇡ ~ ⇄</span>, says: 'a pull request from the stack, history, or the task itself' },
];

/** The `?` sheet. Escape, a click outside, or `?` again puts it away. */
export function KeysSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) sheetRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal keys-sheet"
        role="dialog"
        aria-label="keys and marks"
        tabIndex={-1}
        ref={sheetRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-title">keys</div>
        <dl className="keys-list">
          {KEYS.map(([key, what]) => (
            <div key={key} className="keys-row">
              <dt>
                <kbd className="key-cap">{key}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-title">marks</div>
        <dl className="keys-list">
          {MARKS.map(({ mark, says }) => (
            <div key={says} className="keys-row">
              <dt aria-hidden="true">{mark}</dt>
              <dd>{says}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
