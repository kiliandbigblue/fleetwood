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
  ['j  k', 'down and up — the cards, or the agents inside one'],
  ['l  h', 'into a card and back out: unfold, then its agents; out again, then fold (→ ← too)'],
  ['n', 'the next card that needs you — opening the hidden drawer if one is in it'],
  ['enter', 'go to the focused card in tmux — on a blocked card, to the pane asking'],
  ['1 – 9', 'answer its prompt, as the terminal numbers it — a lasting yes takes two presses'],
  ['a  d', 'the approve and deny answers'],
  ['m', 'its menu — arrows to move, esc to close'],
  ['⌘K', 'jump to any tmux session'],
  ['⌘T', 'new task'],
  ['⌘N', 'your notes'],
  ['⌘R', 'refresh everything'],
  ['esc', 'close what is on top, then leave an opened task'],
];

/** A mark, drawn by the class the list draws it with, and what it says. */
const MARKS: ReadonlyArray<{ mark: React.JSX.Element; says: string }> = [
  { mark: <span className="attached-dot sev-danger" />, says: 'an agent here is stopped on a permission prompt' },
  { mark: <span className="attached-dot sev-ok" />, says: 'an agent here is working' },
  { mark: <span className="attached-dot sev-quiet" />, says: 'every agent here is idle' },
  { mark: <span className="attached-dot sev-ok guessed" />, says: 'seems to be working — nobody reported it' },
  { mark: <span className="status-dot status-working" />, says: 'an agent, reported' },
  { mark: <span className="status-dot status-idle inferred" />, says: 'an agent, guessed — hollow always means a guess' },
  { mark: <span className="status-dot status-gone" />, says: 'an agent that has gone' },
  { mark: <span className="task-status-dot task-status-wip" />, says: 'a parked task, and how far along it is — the ring fills as it lands' },
  { mark: <span className="task-status-dot task-status-not-started" />, says: 'dotted: nothing committed yet, or no session' },
  { mark: <span className="status-dot status-error" />, says: 'square: an agent in error — see its row' },
  { mark: <span className="nested">⤶</span>, says: 'an agent another agent spawned' },
  { mark: <span className="nested">⇢</span>, says: 'runs in the claude daemon, not in the pane' },
  { mark: <span className="subagents">+2</span>, says: 'subagents running under it' },
  {
    mark: <span className="provenance">guessed</span>,
    says: 'a status nobody reported — also "no hooks" or "stale"; its dot is hollow',
  },
  { mark: <span className="context-fig warn">312k</span>, says: 'context the next turn re-reads — gold, then red, as it gets costly' },
  { mark: <span className="task-pr-via">⇡ ~ ⇄</span>, says: 'a pull request from the stack, history, or the task itself' },
];

/** The `?` sheet. Escape, a click outside, or `?` again puts it away. */
export function KeysSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const sheetRef = useRef<HTMLDivElement>(null);
  /*
   * Where you were when you asked, and where you go back to.
   *
   * A sheet that closes onto `body` throws away your place: the next `j` starts
   * from the top of the list again. So the focused element at open is kept and
   * handed focus back on close — if it is still on the page after the redraws
   * that happened while you read.
   */
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      sheetRef.current?.focus();
      return;
    }
    if (returnTo.current?.isConnected) returnTo.current.focus();
    returnTo.current = null;
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal keys-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="keys and marks"
        tabIndex={-1}
        ref={sheetRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            // Nothing in here takes focus but the sheet itself, so the trap is
            // simply staying put: Tab must not walk out into the list behind.
            event.preventDefault();
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
