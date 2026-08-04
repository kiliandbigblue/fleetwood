import { glob, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentUsage } from './usageFormat.ts';

// The shape and its formatters live in a leaf module with no Node imports, so
// the renderer can bundle them without dragging tmux and `child_process` in.
export type { AgentUsage };
export {
  describeUsage,
  formatCost,
  formatMoney,
  formatTokens,
} from './usageFormat.ts';

/** Dollars per million tokens, input and output. */
interface Price {
  in: number;
  out: number;
}

/**
 * Published API rates, keyed by normalized model id.
 *
 * A Claude Code subscription doesn't bill per token, so this is what the same
 * work would have cost through the API — a comparable number across agents,
 * which is what makes one row's spend worth looking at next to another's.
 */
const PRICES: Record<string, Price> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/** Cache multipliers, applied to the model's input rate. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

/**
 * Reduce a wire model id to a pricing key.
 *
 * Bedrock prefixes the provider, dated snapshots suffix the release, and the
 * long-context variant carries a `[1m]` marker — none of which change the rate.
 */
export function normalizeModel(model: string): string {
  return model
    .replace(/^anthropic\./, '')
    .replace(/\[1m\]$/, '')
    .replace(/-\d{8}$/, '');
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpriced: false,
    models: [],
    messages: 0,
  };
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    unpriced: a.unpriced || b.unpriced,
    models: [...new Set([...a.models, ...b.models])],
    messages: a.messages + b.messages,
  };
}

/** Sum a set of per-agent figures, or undefined when none of them had any. */
export function sumUsage(parts: (AgentUsage | undefined)[]): AgentUsage | undefined {
  const present = parts.filter((p): p is AgentUsage => p !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce(addUsage, emptyUsage());
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface WireUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  };
}

/**
 * Fold one message's usage into a running total.
 *
 * The 5m/1h split matters: an hour-long cache write costs 2× the input rate
 * against 1.25× for the five-minute one, and Claude Code writes 1h entries by
 * default — charging everything at 1.25× understates a long session noticeably.
 * Older transcripts have no `cache_creation` object, so the flat field is the
 * fallback at the cheaper rate.
 */
export function foldMessage(into: AgentUsage, model: string, usage: WireUsage): void {
  const key = normalizeModel(model);
  const price = PRICES[key];

  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const read = num(usage.cache_read_input_tokens);

  const split = usage.cache_creation;
  let write5m = num(split?.ephemeral_5m_input_tokens);
  let write1h = num(split?.ephemeral_1h_input_tokens);
  if (write5m === 0 && write1h === 0) write5m = num(usage.cache_creation_input_tokens);

  into.inputTokens += input;
  into.outputTokens += output;
  into.cacheWriteTokens += write5m + write1h;
  into.cacheReadTokens += read;
  into.totalTokens += input + output + write5m + write1h + read;
  into.messages += 1;
  if (!into.models.includes(key)) into.models.push(key);

  if (!price) {
    into.unpriced = true;
    return;
  }
  into.costUsd +=
    (input * price.in +
      output * price.out +
      write5m * price.in * CACHE_WRITE_5M +
      write1h * price.in * CACHE_WRITE_1H +
      read * price.in * CACHE_READ) /
    1_000_000;
}

interface TranscriptLine {
  isSidechain?: unknown;
  requestId?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: WireUsage;
  };
}

/**
 * One assistant turn is written as one line *per content block* — thinking,
 * text, and each tool_use — and every one of those lines repeats the same
 * cumulative usage under the same `message.id`. Measured on a real transcript:
 * 738 usage-bearing lines for 377 actual messages. Summing them all roughly
 * doubles every figure, so identity is the message id.
 */
function dedupeKey(line: TranscriptLine): string | undefined {
  const id = line.message?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  const request = line.requestId;
  return typeof request === 'string' && request.length > 0 ? request : undefined;
}

interface CacheEntry {
  /** Bytes consumed so far — always a line boundary. */
  offset: number;
  seen: Set<string>;
  totals: AgentUsage;
}

/**
 * Per-file fold state, so the 1s fleet poll re-reads only what was appended.
 *
 * Transcripts reach 5MB; re-parsing every one of them every tick is not an
 * option, and neither is trusting a line count — the dedupe set has to persist
 * across reads or an appended block re-counts a message already folded.
 */
const cache = new Map<string, CacheEntry>();

/** Test seam: forget everything so a fixture path can be reused. */
export function resetCache(): void {
  cache.clear();
}

/**
 * Fold a transcript's usage, reading only the bytes added since last time.
 *
 * Returns undefined when the file cannot be read at all; an existing-but-empty
 * transcript folds to zeroes, which is the honest answer for an agent that has
 * started but not yet spent anything.
 */
export async function readTranscriptUsage(path: string): Promise<AgentUsage | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }

  let entry = cache.get(path);
  // A shorter file is a different file: the session was cleared or the path was
  // reused. Reading on from a stale offset would fold the middle of a line.
  if (!entry || size < entry.offset) {
    entry = { offset: 0, seen: new Set(), totals: emptyUsage() };
    cache.set(path, entry);
  }
  if (size === entry.offset) return { ...entry.totals, models: [...entry.totals.models] };

  let chunk: string;
  try {
    const handle = await open(path, 'r');
    try {
      const length = size - entry.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, entry.offset);
      chunk = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return entry.offset > 0 ? { ...entry.totals, models: [...entry.totals.models] } : undefined;
  }

  // Stop at the last newline and leave the remainder unread rather than keeping
  // a decoded fragment: a hook writing this file mid-read can split a multi-byte
  // character, and a re-read from the byte offset repairs that where a retained
  // string could not.
  const end = chunk.lastIndexOf('\n');
  if (end === -1) return { ...entry.totals, models: [...entry.totals.models] };
  const consumed = chunk.slice(0, end + 1);
  entry.offset += Buffer.byteLength(consumed, 'utf8');

  for (const raw of consumed.split('\n')) {
    if (raw.length === 0) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      // A line the writer had not finished when we statted it. The byte offset
      // stopped short of it, so the next read sees it whole.
      continue;
    }
    const usage = line.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const model = line.message?.model;
    // `<synthetic>` marks a locally generated message — no request, no charge.
    if (typeof model !== 'string' || model.startsWith('<')) continue;
    const key = dedupeKey(line);
    if (key !== undefined) {
      if (entry.seen.has(key)) continue;
      entry.seen.add(key);
    }
    // Sidechain lines are subagent turns, and they land in the parent's
    // transcript. That spend belongs to the session that spawned them.
    foldMessage(entry.totals, model, usage);
  }

  return { ...entry.totals, models: [...entry.totals.models] };
}

/** Where Claude Code keeps transcripts, one directory per slugified cwd. */
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

/**
 * Find a session's transcript when no hook ever carried the path.
 *
 * The file is named for the session id, but the directory is derived from the
 * launch cwd, which we may not have — so it is a search rather than a join.
 */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  try {
    for await (const match of glob(`*/${sessionId}.jsonl`, { cwd: CLAUDE_PROJECTS })) {
      return join(CLAUDE_PROJECTS, match);
    }
  } catch {
    // No projects directory, or an unreadable one — nothing to report.
  }
  return undefined;
}

/**
 * Usage for one agent, given whatever it told us about itself.
 *
 * A hook-reported transcript is used directly; otherwise the session id is
 * searched for. An agent found only in `ps` has neither, and gets nothing —
 * which the UI renders as an absent figure, not as zero spend.
 */
export async function usageFor(args: {
  transcript?: string;
  sessionId?: string;
  tool?: string;
}): Promise<AgentUsage | undefined> {
  if (args.tool !== undefined && args.tool !== 'claude') return undefined;
  if (args.transcript) {
    const found = await readTranscriptUsage(args.transcript);
    if (found) return found;
  }
  if (!args.sessionId) return undefined;
  const path = await findTranscript(args.sessionId);
  return path ? readTranscriptUsage(path) : undefined;
}
