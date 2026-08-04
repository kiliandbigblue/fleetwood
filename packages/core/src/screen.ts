import type { AgentStatus } from './types.ts';

export interface PromptOption {
  /** The key to send to choose this option. */
  key: string;
  label: string;
  selected: boolean;
}

export interface ScreenRead {
  /** Only set when the screen says something definite. */
  status?: AgentStatus;
  question?: string;
  options: PromptOption[];
}

const OPTION_LINE = /^(?:❯|>)?\s*(\d+)[.)]\s+(.+?)$/;
const SELECTED_LINE = /^(?:❯|>)\s*\d+[.)]/;

/**
 * Strip the box drawing Claude Code renders prompts inside.
 *
 * Only the edges: a `|` in the middle of a line is probably a shell pipe in the
 * command being approved, and mangling that would misreport what you're agreeing
 * to.
 */
function unbox(line: string): string {
  return line.replace(/^[\s│┃╎┆|]+/, '').replace(/[\s│┃╎┆|]+$/, '');
}

/**
 * Signals that Claude Code is mid-turn. It prints an interrupt affordance while
 * and only while it is working.
 */
const WORKING_MARKERS = ['esc to interrupt', 'ctrl+b to run in background'];

/** Phrasings that introduce a permission prompt. */
const PERMISSION_MARKERS = [
  'do you want to',
  'would you like to',
  'allow this',
  'requesting permission',
];

/**
 * Best-effort reading of a pane's visible text.
 *
 * This is the fallback for when hooks are absent or stale, and the source for
 * the approve/deny buttons — so it returns the actual prompt text and options
 * rather than just a verdict, letting the human see what they're approving.
 *
 * Deliberately conservative: an unrecognised screen yields no status at all,
 * because a wrong "idle" is worse than an honest "unknown".
 */
export function readScreen(text: string): ScreenRead {
  const lines = text.split('\n');
  const lower = text.toLowerCase();

  const options: PromptOption[] = [];
  let optionsStart = -1;

  // Scan from the bottom: prompts live at the end of the visible buffer, and
  // older prompts further up have already been answered.
  for (let i = lines.length - 1; i >= 0 && lines.length - i < 40; i--) {
    const line = unbox(lines[i] as string);
    const m = OPTION_LINE.exec(line);
    if (m) {
      options.unshift({
        key: m[1] as string,
        label: (m[2] as string).replace(/\s+/g, ' ').trim(),
        selected: SELECTED_LINE.test(line),
      });
      optionsStart = i;
    } else if (options.length > 0 && line === '') {
      // Blank line above the block ends it.
      if (optionsStart >= 0 && i < optionsStart - 1) break;
    } else if (options.length >= 2) {
      break;
    }
  }

  let question: string | undefined;
  if (optionsStart > 0) {
    for (let i = optionsStart - 1; i >= 0 && optionsStart - i < 8; i--) {
      const line = unbox(lines[i] as string);
      if (line.length === 0) continue;
      question = line;
      break;
    }
  }

  const hasPermissionWording =
    PERMISSION_MARKERS.some((m) => lower.includes(m)) ||
    (question !== undefined && /\?\s*$/.test(question));

  if (options.length >= 2 && hasPermissionWording) {
    return { status: 'blocked_permission', question, options };
  }

  if (WORKING_MARKERS.some((m) => lower.includes(m))) {
    return { status: 'working', options: [] };
  }

  return { options };
}

/** The keystroke that accepts / rejects, if the prompt offers an obvious one. */
export function approvalKeys(options: PromptOption[]): { approve?: string; deny?: string } {
  const approve = options.find((o) => /^(yes|allow|approve)\b/i.test(o.label));
  const deny = options.find((o) => /^(no|deny|reject|cancel)\b/i.test(o.label) || /\bno,\s/i.test(o.label));
  return { approve: approve?.key, deny: deny?.key };
}
