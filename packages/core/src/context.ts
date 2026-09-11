import { open, stat } from 'node:fs/promises';

/**
 * How much context an agent is carrying right now, read off its transcript.
 *
 * Distinct from what an agent has spent, which fleetwood deliberately does not
 * show: spend is history and no control here makes it smaller. Context is a
 * live property with an action attached — it is what the *next* turn will
 * re-read, so it says which pane to stop giving work to, and `/clear` empties
 * it. `AgentState.transcript` is the pointer this starts from, kept for exactly
 * this when the pricing pipeline came out.
 *
 * The cheap half of that distinction is what makes this ~40 lines where
 * `usage.ts` was 500: spend is a *sum*, so every message had to be folded
 * exactly once forever — a dedupe set, a byte offset, per-model rates. Context
 * is a *level*, held in one field of the latest turn. Reading it twice cannot
 * drift, so there is nothing to keep but the answer.
 */

/**
 * Bytes of tail to read.
 *
 * Enough for several assistant records at their usual size. Tool *results* are
 * the big records and they are `user` ones, which this skips anyway; an
 * assistant turn is text, thinking and tool calls. A transcript whose last
 * records somehow exceed this reads as unknown rather than wrong, which is the
 * right way round.
 */
const TAIL_BYTES = 128 * 1024;

interface Cached {
  size: number;
  tokens: number | undefined;
}

/**
 * Keyed by path and validated by size, so an idle agent costs one `stat`.
 *
 * The fleet poll runs every second and most agents are between turns; a
 * transcript that has not grown cannot have changed its context.
 */
const cache = new Map<string, Cached>();

/** Test seam: forget everything so a fixture path can be reused. */
export function resetContextCache(): void {
  cache.clear();
}

interface TranscriptLine {
  isSidechain?: unknown;
  message?: {
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * The prompt that turn actually sent: fresh input, cache reads and cache writes.
 *
 * All three, because the split between them is a billing detail and the
 * question here is size. A turn that re-cached its whole history reports the
 * same context as the one that read it back, which is correct — the
 * conversation is the same length either way.
 */
function contextOf(line: TranscriptLine): number | undefined {
  const usage = line.message?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const model = line.message?.model;
  // `<synthetic>` marks a locally generated message — no request behind it, so
  // no context was sent for it.
  if (typeof model !== 'string' || model.startsWith('<')) return undefined;
  // Subagent turns land in the parent's transcript and carry the subagent's own
  // context, which is not what this pane will re-read on its next turn.
  if (line.isSidechain === true) return undefined;
  const total =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens);
  return total > 0 ? total : undefined;
}

/**
 * Context tokens on the newest real turn, or undefined.
 *
 * Undefined covers every failure the same way — no file, no permission, no
 * parseable record in the tail — because the column has an honest empty state
 * and a wrong number here would be read as a fact about the agent.
 */
export async function readContextTokens(path: string): Promise<number | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }

  const hit = cache.get(path);
  if (hit && hit.size === size) return hit.tokens;

  const start = Math.max(0, size - TAIL_BYTES);
  let chunk: string;
  try {
    const handle = await open(path, 'r');
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      chunk = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  const lines = chunk.split('\n');
  // Reading from an offset lands mid-record, so the first fragment is only a
  // whole line when the whole file fitted in the window.
  const floor = start === 0 ? 0 : 1;
  let tokens: number | undefined;
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const raw = lines[i];
    if (raw === undefined || raw.length === 0) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      // A record the writer had not finished when we statted the file. The next
      // poll sees a bigger file and reads it whole.
      continue;
    }
    const found = contextOf(line);
    if (found !== undefined) {
      tokens = found;
      break;
    }
  }

  cache.set(path, { size, tokens });
  return tokens;
}
