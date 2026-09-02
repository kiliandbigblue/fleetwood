import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskRepo } from '@fleetwood/core';
import { fuzzyRank } from '@fleetwood/core/fuzzy';
// The clamping rule, shared on purpose: two keyboard-driven lists in one window
// that answer ArrowUp differently is the sort of thing you feel without being
// able to name — see `moveCursor`.
import { moveCursor } from './newTaskFlow.ts';
import { send } from './api.ts';

/** One repo `+ repo` can offer: a git checkout under the configured roots. */
interface RepoCandidate {
  path: string;
  /** The directory name, which is what `addRepoToTask` resolves against. */
  name: string;
  /** `owner/name`, when the checkout has an origin. */
  repo?: string;
}

/**
 * Whether a task already holds this repo.
 *
 * Marked rather than filtered out, because adding a repo the task already has is
 * the whole of stacked work — a second branch of `reflow` in its own worktree.
 * Matched on the origin first: a stacked task's directories are named for their
 * branches, so none of them is called `reflow` and the name alone misses them.
 */
function alreadyInTask(repos: readonly TaskRepo[], candidate: RepoCandidate): boolean {
  return repos.some((r) =>
    candidate.repo !== undefined && r.repo !== undefined
      ? r.repo === candidate.repo
      : r.name === candidate.name || r.name.startsWith(`${candidate.name}-`),
  );
}

interface Props {
  task: Task;
  /** Closes the editor. The caller owns whether it is open; this owns the rest. */
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}

/**
 * `+ repo`, shared by the task card and the task pane.
 *
 * Both surfaces ask the same question and must not come to disagree about the
 * answer — the same reason `AgentRow`, `PrRow` and `TaskNotes` are shared
 * between them. It was duplicated as a bare text input, which is how the pane
 * came to keep asking you to spell a checkout from memory after the card had
 * stopped.
 *
 * Two beats rather than one input, which is what the repo name and an optional
 * branch used to share as two words. One input meant the repo half could not be
 * a list — and a bare field is the one thing here that asks you to already know
 * how a checkout is spelled, about the answer sitting in `~/projects`. The
 * branch is asked second because it has a good default and the repo has none.
 *
 * Mounted only while open, so closing it is what resets it — there is no third
 * state to keep in step with the caller's boolean.
 */
export function AddRepo({ task, onClose, onResult }: Props): React.JSX.Element {
  const [step, setStep] = useState<'repo' | 'branch'>('repo');
  const [candidates, setCandidates] = useState<RepoCandidate[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<RepoCandidate | undefined>();
  const [branchDraft, setBranchDraft] = useState('');
  /** The row the cursor is on, so the arrows can keep it in view. */
  const atRef = useRef<HTMLDivElement>(null);

  /*
   * Fetched on mount rather than held by the caller: there is one card per task
   * on screen and the list is the same for all of them, so holding it per card
   * would be as many identical scans as there are tasks — every second, for a
   * list nobody has opened.
   */
  useEffect(() => {
    void send({ kind: 'listProjects' }).then((result) => {
      // Only real checkouts: `addRepoToTask` refuses a plain directory, so
      // offering one would be offering a row that cannot be taken.
      if ('projects' in result) setCandidates(result.projects.filter((project) => project.isRepo));
    });
  }, []);

  /*
   * What the filter matches, best first. Subsequence rather than substring, the
   * same as the new-task repo step: `fltwd` finds `fleetwood`, and the point of
   * the list is that recognising beats recalling.
   *
   * Capped because the roots hold rather more repos than a card has room for,
   * and forty rows is already more than anyone scrolls before typing instead.
   */
  const matches = useMemo(
    () => fuzzyRank(candidates, query, (candidate) => candidate.name).slice(0, 40),
    [candidates, query],
  );

  /*
   * The row under the cursor, brought along — the list is taller than its window
   * and the arrows are the way through it. `nearest`, so it moves only once the
   * cursor has actually left the view.
   */
  useEffect(() => {
    atRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches.length]);

  const pickRepo = (candidate: RepoCandidate): void => {
    setPicked(candidate);
    // Pre-filled with the task's own branch, which is the answer nine times in
    // ten — so the second beat is usually just one more Enter.
    setBranchDraft(task.branch);
    setStep('branch');
  };

  const submit = async (candidate: RepoCandidate): Promise<void> => {
    const branch = branchDraft.trim();
    onClose();
    const result = await send({
      kind: 'addRepoToTask',
      slug: task.slug,
      repo: candidate.name,
      // The task's branch is what the backend falls back to, so sending it would
      // only be a second way of spelling the default.
      branch: branch.length > 0 && branch !== task.branch ? branch : undefined,
    });
    onResult(result.detail, result.ok);
  };

  if (step === 'branch' && picked) {
    return (
      <form
        className="add-repo"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(picked);
        }}
      >
        <div className="add-repo-row">
          {/* The answer to the first question, kept on screen: this field says
              nothing about which repo it is about otherwise. */}
          <span className="add-repo-picked">{picked.name}</span>
          <input
            autoFocus
            value={branchDraft}
            placeholder={task.branch}
            onChange={(event) => setBranchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              // Not the pane: escape closes whatever is innermost, and here that
              // is a beat back rather than the whole editor. Going back is what
              // makes the first question worth answering with Enter.
              event.stopPropagation();
              setStep('repo');
            }}
          />
          <button className="chip" type="submit">
            add
          </button>
        </div>
        <div className="add-repo-foot">
          <span className="task-notes-hint">
            {branchDraft.trim() === task.branch
              ? '↵ add on the task’s branch · esc back'
              : '↵ add on this branch — a worktree of its own · esc back'}
          </span>
        </div>
      </form>
    );
  }

  return (
    <div className="add-repo">
      <div className="add-repo-row">
        <input
          autoFocus
          value={query}
          placeholder="which repo? — a few letters is enough"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // As above: the innermost thing closes, not the pane behind it.
              event.stopPropagation();
              onClose();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((c) => moveCursor(c, event.key === 'ArrowDown' ? 1 : -1, matches.length));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const candidate = matches[cursor];
              if (candidate) pickRepo(candidate);
            }
          }}
        />
      </div>
      <div className="choices">
        {/* Empty while the scan is out, and empty because nothing matched, read
            the same on screen — so say which. */}
        {matches.length === 0 && (
          <div className="add-repo-empty">
            {candidates.length === 0 ? 'looking…' : 'no repo matches'}
          </div>
        )}
        {matches.map((candidate, index) => {
          const held = alreadyInTask(task.repos, candidate);
          return (
            <div
              key={candidate.path}
              ref={index === cursor ? atRef : undefined}
              className={`choice${index === cursor ? ' at' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => pickRepo(candidate)}
              title={candidate.path}
            >
              <span className="choice-mark">{index === cursor ? '›' : ''}</span>
              <span className="choice-name">{candidate.name}</span>
              {held && <span className="add-repo-held">already here</span>}
            </div>
          );
        })}
      </div>
      <div className="add-repo-foot">
        <span className="task-notes-hint">↑↓ move · ↵ take it · esc cancel</span>
      </div>
    </div>
  );
}
