interface Props {
  /** What is on disk. The textarea reads `draft`, never this — see `TaskCard`. */
  notes?: string;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onOpen: () => void;
  onCancel: () => void;
  onSave: () => void;
  /**
   * What to draw in place of a note there isn't one of.
   *
   * The card passes none: a task with no notes shows nothing, because a list of
   * twelve cards each carrying an empty box is twelve rows of nothing. The pane
   * passes one, because a section that vanishes from a page about a single task
   * reads as a section that doesn't exist.
   */
  placeholder?: string;
}

/**
 * Your own notes on a task, in the two places a task is drawn.
 *
 * Shared rather than written twice because the editing rules are the fiddly part
 * — ⌘↵ saves and a bare Enter must stay a newline, escape cancels, and the value
 * is held apart from the snapshot so a poll cannot replace what you are typing.
 * Which of those is wrong is not a thing you would notice twice.
 *
 * The state lives in the parent, not here: both call sites open this from
 * their menu, and a component that owns its own `editing` flag cannot be
 * opened from outside it.
 */
export function TaskNotes({
  notes,
  editing,
  draft,
  onDraft,
  onOpen,
  onCancel,
  onSave,
  placeholder,
}: Props): React.JSX.Element | null {
  if (editing) {
    return (
      <div className="task-notes-edit">
        <textarea
          autoFocus
          rows={5}
          value={draft}
          placeholder="notes on this task — saved to NOTES.md beside the worktrees"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Closes the editor and stops there: escape means the innermost
              // thing open, and in the pane the next one out is the pane itself.
              event.stopPropagation();
              onCancel();
              return;
            }
            // ⌘↵ saves. A bare Enter has to stay a newline — it is a notes box.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSave();
            }
          }}
        />
        <div className="task-notes-actions">
          <span className="task-notes-hint">⌘↵ save · esc cancel</span>
          <button className="chip" onClick={onCancel}>
            cancel
          </button>
          <button className="chip" onClick={onSave}>
            save
          </button>
        </div>
      </div>
    );
  }

  /*
   * Labelled, like every other group on a card.
   *
   * The worktrees announce themselves by being worktree names and the pull
   * requests carry `4 open · stack of 4` over them; this block carried nothing,
   * so a paragraph of English arrived under a stack of machine rows as the one
   * thing on the card that never said what it was — it read as a stray comment
   * rather than as the one part a person wrote. The heading is the same micro
   * label the pull requests already use, in the same place.
   */
  if (notes) {
    return (
      <div className="task-notes-block">
        <div className="task-notes-label">note</div>
        <div className="task-notes" onClick={onOpen} title="click to edit · kept in NOTES.md">
          {notes.trim()}
        </div>
      </div>
    );
  }

  return placeholder ? (
    <div className="task-notes-block">
      <div className="task-notes-label">note</div>
      <div
        className="task-notes empty"
        onClick={onOpen}
        title="click to write one · kept in NOTES.md"
      >
        {placeholder}
      </div>
    </div>
  ) : null;
}
