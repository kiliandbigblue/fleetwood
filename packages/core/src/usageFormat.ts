/**
 * Spend, and how to say it.
 *
 * Deliberately free of imports — Node builtins included. The renderer bundles
 * this module directly (`@fleetwood/core/usageFormat`) because pulling the same
 * names through core's barrel drags `child_process` and `fs` into a browser
 * build, and both UIs must format these numbers the same way.
 */

/**
 * What an agent has spent.
 *
 * Claude folds this from its transcript; Cursor accumulates it from `stop`
 * hook token fields (its transcript carries no usage). Cost is the headline
 * rather than a token count because cache reads dominate the totals — a
 * session measured at 130M tokens cost $101, ~95% of those tokens being reads
 * at a tenth of the input rate. "130M" reads as enormous whatever the agent
 * actually did; "$101" is the number you can act on.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Every token the agent was billed for, cache reads included. */
  totalTokens: number;
  costUsd: number;
  /**
   * Some messages ran on a model with no published rate on file.
   *
   * Their tokens are counted but their cost is not, so the figure is a floor.
   * Surfaced rather than swallowed: a model released after the price table was
   * written must not quietly under-report the bill.
   */
  unpriced: boolean;
  /** Distinct models seen, in first-seen order — a turn can switch mid-session. */
  models: string[];
  /** Assistant messages folded, after de-duplication. */
  messages: number;
}

/**
 * Compact token count: `847`, `12k`, `1.6M`.
 *
 * Only ever shown in a tooltip. On a row a token figure misleads — cache reads
 * are most of it, so every busy agent reads as "millions" whatever it did.
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return `${Math.max(0, Math.round(n))}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Dollars, floored at a cent so a just-started agent doesn't read as free. */
export function formatMoney(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  // Cents stop earning their place once a session is into three figures.
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

/** The figure as shown, `~`-prefixed when it is only a floor. */
export function formatCost(usage: AgentUsage): string {
  return `${usage.unpriced ? '~' : ''}${formatMoney(usage.costUsd)}`;
}

/**
 * The breakdown a row cannot fit, as prose for a tooltip.
 *
 * Shared rather than per-renderer: the app and the CLI describe the same
 * numbers, and `describeToolUse` set the precedent that human-readable
 * formatting belongs in core beside the data.
 */
export function describeUsage(usage: AgentUsage): string {
  const parts = [
    `${formatTokens(usage.totalTokens)} tokens`,
    `${formatTokens(usage.inputTokens)} in`,
    `${formatTokens(usage.outputTokens)} out`,
    `${formatTokens(usage.cacheWriteTokens)} cache write`,
    `${formatTokens(usage.cacheReadTokens)} cache read`,
  ];
  if (usage.models.length > 0) parts.push(usage.models.join(', '));
  parts.push(
    usage.unpriced
      ? 'at least this much — one model has no published rate on file'
      : 'estimated at API rates',
  );
  return parts.join(' · ');
}
