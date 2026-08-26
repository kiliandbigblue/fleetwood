import { useEffect, useMemo, useRef, useState } from 'react';
import { send } from './api.ts';
import type { Draft } from './newTaskFlow.ts';
import {
  canAdvance,
  confirmChoice,
  EMPTY_DRAFT,
  moveCursor,
  previewBranch,
  STEPS,
  TASK_TYPES,
  toggleChoice,
  visibleChoices,
} from './newTaskFlow.ts';

interface Project {
  path: string;
  name: string;
  repo?: string;
  isRepo: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Summary the flow opens with — what was typed into ⌘K before choosing to make
   * a task of it. It is answered in step four rather than skipped to: the repos
   * still have to be picked, and arriving at a question already answered is a
   * better outcome than being dropped into the middle of a form.
   */
  initialSummary?: string;
  onResult: (message: string, ok: boolean) => void;
}

/**
 * Create a task: one branch, a worktree per repo, one session.
 *
 * Asked one question at a time, in the shape `gum` gives a shell script — every
 * question keyed the same way, and the answers stacking up above the current one
 * as lines you can click to go back to. The form this replaced put all five
 * fields on screen at once, which read as five things to decide before anything
 * happened; they are in fact one decision each, and only the first of them is
 * hard.
 *
 * The keys are gum's: ↑↓ move, Enter takes what you are on, Tab builds a set out
 * of several, Esc steps back. Enter meaning both "take this one" and "take the
 * set I built" is what keeps Tab from being a mode you have to enter — see
 * `confirmChoice`.
 */
export function NewTask({ open, onClose, initialSummary, onResult }: Props): React.JSX.Element | null {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [repos, setRepos] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [toggled, setToggled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLDivElement>(null);

  const step = STEPS[index] as (typeof STEPS)[number];
  const last = index === STEPS.length - 1;

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setDraft({ ...EMPTY_DRAFT, summary: initialSummary ?? '' });
    setBusy(false);
    setRepos([]);
    void send({ kind: 'listProjects' }).then((result) => {
      if ('projects' in result) {
        setRepos(result.projects.filter((p: Project) => p.isRepo).map((p: Project) => p.name));
      }
    });
  }, [open, initialSummary]);

  const options = useMemo(() => {
    if (step.kind !== 'choose') return [];
    return step.key === 'repos' ? visibleChoices(repos, query, toggled) : [...TASK_TYPES];
    // `toggled` is deliberately out of the deps: re-pinning the list under the
    // cursor on every Tab would move the row you were about to press Tab on.
  }, [step, repos, query]);

  /*
   * Entering a step, forwards or back. Seeded from the draft rather than blank,
   * so stepping back shows what you had picked instead of asking again — the
   * back-link is only worth having if it lands you where you left.
   */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const picked = step.key === 'repos' ? draft.repos : [];
    setToggled(picked);
    /*
     * The cursor lands on the answer you already gave, not at the top. Coming
     * back to a forty-repo list to find it scrolled to `ImageGoNord-Web` is being
     * asked the question again rather than shown what you said.
     */
    setCursor(
      step.key === 'type'
        ? Math.max(TASK_TYPES.indexOf(draft.type as 'feature'), 0)
        : step.key === 'repos'
          ? Math.max(visibleChoices(repos, '', picked).indexOf(picked[0] ?? ''), 0)
          : 0,
    );
    // A step with no field of its own still has to hear the keys.
    const focus = (): void => (step.kind === 'text' || step.key === 'repos' ? fieldRef : modalRef).current?.focus();
    focus();
  }, [open, index]);

  /*
   * The list is taller than its window, and the keys are the way through it — so
   * the row under the cursor has to be brought along. `nearest` so it scrolls
   * only when the cursor has actually left the view.
   */
  useEffect(() => {
    atRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, options.length]);

  if (!open) return null;

  const setField = (key: 'microservice' | 'summary' | 'goal', value: string): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (final: Draft): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await send({
      kind: 'createTask',
      type: final.type,
      microservice: final.microservice,
      summary: final.summary,
      goal: final.goal.trim().length > 0 ? final.goal.trim() : undefined,
      repos: final.repos,
    });
    setBusy(false);
    onResult(result.detail, result.ok);
    if (result.ok) onClose();
  };

  const advance = async (): Promise<void> => {
    let next = draft;
    if (step.kind === 'choose') {
      const chosen = confirmChoice(toggled, options, cursor);
      if (chosen.length === 0) return;
      next = step.key === 'repos' ? { ...draft, repos: chosen } : { ...draft, type: chosen[0] as string };
      setDraft(next);
    }
    if (!canAdvance(step.key, next)) return;
    if (last) await submit(next);
    else setIndex(index + 1);
  };

  // Esc walks back out the way you came in, and off the end of it closes.
  const back = (): void => (index === 0 ? onClose() : setIndex(index - 1));

  const onKey = (event: React.KeyboardEvent): void => {
    if (busy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      back();
    } else if (event.key === 'Tab' && step.kind === 'choose') {
      // Swallowed either way: Tab moving focus out of a list you are steering
      // with the keyboard is worse than Tab doing nothing.
      event.preventDefault();
      const name = options[cursor];
      if (step.multi && name !== undefined) setToggled((t) => toggleChoice(t, name));
    } else if (step.kind === 'choose' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setCursor((c) => moveCursor(c, event.key === 'ArrowDown' ? 1 : -1, options.length));
    } else if (event.key === 'Enter') {
      // Enter belongs to the flow, so the multi-line box gets ⇧↵ for a newline.
      if (event.shiftKey && step.key === 'goal') return;
      event.preventDefault();
      void advance();
    }
  };

  const ready = step.kind === 'choose' ? confirmChoice(toggled, options, cursor).length > 0 : canAdvance(step.key, draft);
  const hint = [
    step.kind === 'choose'
      ? step.multi
        ? '↵ take the one you’re on · tab add more'
        : '↵ take it'
      : last
        ? '↵ create · ⇧↵ newline'
        : '↵ next',
    'esc back',
  ].join(' · ');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" ref={modalRef} tabIndex={-1} onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">new task</div>

        {/* The answers so far, as lines rather than fields — the flow's scrollback.
            Each is the way back to the question that made it. */}
        {STEPS.slice(0, index).map((done, i) => (
          <button key={done.key} className="step-done" onClick={() => setIndex(i)} title={`back to ${done.key}`}>
            <span className="step-done-key">{done.key}</span>
            <span className="step-done-value">{done.answer(draft)}</span>
          </button>
        ))}

        <div className="step-question">{step.question}</div>

        {step.kind === 'choose' ? (
          <>
            {step.key === 'repos' && (
              <input
                ref={fieldRef}
                className="field"
                value={query}
                placeholder={step.placeholder}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
              />
            )}
            <div className="choices">
              {options.length === 0 && <div className="empty">no repo matches</div>}
              {options.map((name, i) => {
                const on = toggled.includes(name);
                return (
                  <div
                    key={name}
                    ref={i === cursor ? atRef : undefined}
                    className={`choice${i === cursor ? ' at' : ''}${on ? ' on' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => {
                      if (step.multi) setToggled((t) => toggleChoice(t, name));
                      else void advance();
                    }}
                  >
                    <span className="choice-mark">{step.multi ? (on ? '✓' : '') : i === cursor ? '›' : ''}</span>
                    <span className="choice-name">{name}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : step.key === 'goal' ? (
          <textarea
            ref={fieldRef}
            className="field"
            rows={3}
            value={draft.goal}
            placeholder={step.placeholder}
            onChange={(event) => setField('goal', event.target.value)}
          />
        ) : (
          <input
            ref={fieldRef}
            className="field"
            value={draft[step.key as 'microservice' | 'summary']}
            placeholder={step.placeholder}
            onChange={(event) => setField(step.key as 'microservice' | 'summary', event.target.value)}
          />
        )}

        {/* The card is one size for all five steps, so the slack lands here — above
            the branch line and the keys, which stay put at the foot of it. */}
        <div className="step-fill" />

        {/* Held back until the type is settled: before that it is all ellipsis and
            says nothing you did not just type. */}
        {index >= 2 && (
          <div className="branch-preview" title="the branch created in every repo you picked">
            {previewBranch(draft)}
          </div>
        )}

        <div className="step-foot">
          <span className="modal-note">{hint}</span>
          <span className="step-count">
            {index + 1} of {STEPS.length}
          </span>
        </div>

        <div className="modal-actions">
          <span className="modal-note">
            {index === 0
              ? 'pick one, or several — you can add more to a task later'
              : `${draft.repos.length} worktree${draft.repos.length === 1 ? '' : 's'} will be created`}
          </span>
          <button className="chip" onClick={back}>
            {index === 0 ? 'cancel' : 'back'}
          </button>
          <button className="button approve" disabled={!ready || busy} onClick={() => void advance()}>
            {busy ? 'creating…' : last ? 'create' : 'next'}
          </button>
        </div>
      </div>
    </div>
  );
}
