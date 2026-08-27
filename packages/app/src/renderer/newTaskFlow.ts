/**
 * The new-task flow as data: the five questions, the draft they fill, and the
 * key semantics the choose steps run on.
 *
 * No React, which is what lets `packages/app/test` drive the Enter/Tab rules
 * without a DOM — they are the whole feel of the thing, and exactly the sort of
 * rule that reads right and behaves wrong.
 *
 * The branch naming used to be copied in here, held to core's original by a test,
 * because reaching it meant reaching `task.ts` and its `node:fs` import would
 * take the bundle down. It lives in `core/naming.ts` now, which has no `node:`
 * imports and can simply be used.
 */
export { buildBranch, slugify } from '@fleetwood/core/naming';
import { buildBranch, slugify } from '@fleetwood/core/naming';

export type StepKey = 'repos' | 'type' | 'microservice' | 'summary' | 'goal';

export interface Draft {
  repos: string[];
  type: string;
  microservice: string;
  summary: string;
  goal: string;
}

export interface Step {
  key: StepKey;
  /** Asked on its own — one question on screen at a time is the point of this. */
  question: string;
  kind: 'choose' | 'text';
  /** Choose steps only: whether Tab may build a set instead of picking one. */
  multi?: boolean;
  placeholder?: string;
  /** How the answer reads on the line left behind once you have moved past it. */
  answer: (draft: Draft) => string;
}

export const TASK_TYPES = ['feature', 'fix', 'chore'] as const;

/**
 * Repos first, which is not the order the fields were in before.
 *
 * It is the answer that decides how much the rest of it matters — a task is a
 * folder of worktrees, and picking none of them is the one way to fill the whole
 * form in and have created nothing worth having. It is also the only question
 * here you answer by *recognising* something rather than composing it, so it is
 * the cheapest one to open on.
 */
export const STEPS: readonly Step[] = [
  {
    key: 'repos',
    question: 'which repos does this touch?',
    kind: 'choose',
    multi: true,
    placeholder: 'filter repos…',
    answer: (draft) => draft.repos.join(', '),
  },
  {
    key: 'type',
    question: 'what kind of change is it?',
    kind: 'choose',
    answer: (draft) => draft.type,
  },
  {
    key: 'microservice',
    question: 'which microservice?',
    kind: 'text',
    placeholder: 'e.g. flow — a domain, not a repo',
    answer: (draft) => draft.microservice,
  },
  {
    key: 'summary',
    question: 'summarise it',
    kind: 'text',
    placeholder: 'e.g. execution labels',
    answer: (draft) => draft.summary,
  },
  {
    key: 'goal',
    question: 'a goal to write into TASK.md?',
    kind: 'text',
    placeholder: 'optional — the brief an agent opening this task reads',
    answer: (draft) => (draft.goal.trim().length > 0 ? draft.goal.trim() : 'none'),
  },
];

export const EMPTY_DRAFT: Draft = {
  repos: [],
  type: 'feature',
  microservice: '',
  summary: '',
  goal: '',
};

/** Whether Enter may leave this step. The goal is the only one you may skip. */
export function canAdvance(step: StepKey, draft: Draft): boolean {
  if (step === 'repos') return draft.repos.length > 0;
  if (step === 'type') return draft.type.trim().length > 0;
  if (step === 'goal') return true;
  return draft[step].trim().length > 0;
}

/**
 * gum's two jobs on one key: Enter takes the set you built with Tab, and takes
 * the row you are standing on if you built none.
 *
 * That is what keeps the multi-select from being a mode. Most tasks are one
 * repo, and the one-repo case never has to find out Tab exists.
 */
export function confirmChoice(
  toggled: readonly string[],
  visible: readonly string[],
  cursor: number,
): string[] {
  if (toggled.length > 0) return [...toggled];
  const under = visible[cursor];
  return under === undefined ? [] : [under];
}

/** Tab: add or drop, keeping the order you picked them in. */
export function toggleChoice(toggled: readonly string[], id: string): string[] {
  return toggled.includes(id) ? toggled.filter((t) => t !== id) : [...toggled, id];
}

/**
 * Clamped rather than wrapping, which is where this parts company with gum: the
 * ⌘K palette beside it clamps, and two lists in one window that answer ArrowUp
 * differently is the sort of thing you feel without being able to name.
 */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(cursor + delta, 0), length - 1);
}

/**
 * The rows on screen: what the filter matches, with anything already picked held
 * on top of it.
 *
 * A selection the filter has hidden is one you can no longer un-pick, and the
 * only way back out of it would be to abandon the form.
 */
export function visibleChoices(
  names: readonly string[],
  query: string,
  toggled: readonly string[],
): string[] {
  const needle = query.toLowerCase().trim();
  const matches = needle.length === 0 ? [...names] : names.filter((n) => n.toLowerCase().includes(needle));
  const pinned = toggled.filter((t) => names.includes(t) && !matches.includes(t));
  return [...pinned, ...matches];
}

/**
 * The branch as it reads part-way through, with what you have not said yet left
 * as an ellipsis rather than quietly closed up.
 *
 * A preview is only worth showing if it cannot pass for finished while it is
 * still a fragment — `feature/flow` and `feature/flow-…` are different promises.
 */
export function previewBranch(draft: Draft): string {
  const kind = slugify(draft.type) || 'feature';
  const microservice = slugify(draft.microservice);
  if (microservice.length === 0) return `${kind}/…`;
  const summary = slugify(draft.summary);
  if (summary.length === 0) return `${kind}/${microservice}-…`;
  return buildBranch(draft.type, draft.microservice, draft.summary);
}
