/**
 * How an agent's context window is written and banded.
 *
 * A leaf module with no Node imports, so the renderer can bundle it without
 * dragging `fs` in — the same split `usageFormat.ts` had, and for the same
 * reason. `context.ts` beside it does the reading and cannot be imported here.
 */

/** Where a context size stops being unremarkable. Both are token counts. */
export interface ContextThresholds {
  warnTokens: number;
  criticalTokens: number;
}

/** Louder than `warn`, or nothing at all — the quiet band has no name. */
export type ContextBand = 'warn' | 'critical' | undefined;

export function contextBand(tokens: number, at: ContextThresholds): ContextBand {
  if (tokens >= at.criticalTokens) return 'critical';
  if (tokens >= at.warnTokens) return 'warn';
  return undefined;
}

/**
 * `412k`, `1.0M` — a magnitude, not a token count.
 *
 * Nobody acts on the difference between 412,000 and 415,000, and the column is
 * beside a duration and a status in a rail four characters wide. Rounded to the
 * thousand up to a million and to a tenth above it, where the extra digit is
 * the difference between "large" and "about to compact".
 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * What the number means, for the hover — consequence, not mechanism.
 *
 * The multiplier is the point: context is re-read on every turn, so a agent at
 * 400k is not "using more memory", it is costing several times what the same
 * question costs in a fresh pane. `baseTokens` is what a session starts at
 * once CLAUDE.md, tools and skills are loaded — the honest denominator for
 * "several times what".
 */
export function describeContext(tokens: number, baseTokens = 40_000): string {
  const times = tokens / baseTokens;
  const ratio = times >= 2 ? `, about ${Math.round(times)}x a fresh session` : '';
  return `${formatContextTokens(tokens)} of context${ratio} — every turn re-reads it. \`/clear\` in this pane resets it.`;
}
