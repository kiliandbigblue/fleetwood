import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { EVENTS_LOG, SPOOL_DIR, STATE_FILE, ensureDirs } from './paths.ts';
import { normalize, reduce } from './events.ts';
import type { AgentEvent, AgentState, SpoolRecord } from './events.ts';

export interface SpoolBatch {
  events: AgentEvent[];
  /** Absolute paths of the files these events came from. */
  files: string[];
  /** Files that were unreadable or not valid JSON. */
  bad: string[];
}

interface DatedFile {
  path: string;
  mtimeNs: bigint;
}

/**
 * Read every pending spool file, oldest first.
 *
 * Ordering comes from mtime at nanosecond resolution rather than the filename,
 * whose epoch-second prefix cannot separate a PreToolUse from the PostToolUse
 * that follows it milliseconds later.
 */
export async function readSpool(): Promise<SpoolBatch> {
  let names: string[];
  try {
    names = await readdir(SPOOL_DIR);
  } catch {
    return { events: [], files: [], bad: [] };
  }

  // `.tmp.*` are hooks mid-write; they become visible under their real name only
  // once renamed into place.
  const candidates = names.filter((n) => n.endsWith('.json') && !n.startsWith('.'));

  const dated: DatedFile[] = [];
  await Promise.all(
    candidates.map(async (name) => {
      const path = join(SPOOL_DIR, name);
      try {
        const s = await stat(path, { bigint: true });
        dated.push({ path, mtimeNs: s.mtimeNs });
      } catch {
        // Vanished between readdir and stat — a concurrent collector took it.
      }
    }),
  );
  dated.sort((a, b) => (a.mtimeNs < b.mtimeNs ? -1 : a.mtimeNs > b.mtimeNs ? 1 : 0));

  const events: AgentEvent[] = [];
  const files: string[] = [];
  const bad: string[] = [];

  for (const { path } of dated) {
    let record: SpoolRecord;
    try {
      record = JSON.parse(await readFile(path, 'utf8')) as SpoolRecord;
    } catch {
      bad.push(path);
      continue;
    }
    files.push(path);
    const event = normalize(record);
    if (event) events.push(event);
  }

  return { events, files, bad };
}

/** Finished or long-silent agents, past the point where showing them helps. */
const GONE_GRACE_SECONDS = 300;
const SILENT_LIMIT_SECONDS = 3_600;

/**
 * Drop agents that are over.
 *
 * The store is keyed by agent session id, so without this every session ever run
 * accumulates in state.json and reappears in the UI as an orphan forever.
 */
export function pruneStates(states: Map<string, AgentState>, now = Math.floor(Date.now() / 1000)): number {
  let removed = 0;
  for (const [key, state] of states) {
    const silentFor = now - state.lastEventAt;
    const expired =
      (state.status === 'gone' && silentFor > GONE_GRACE_SECONDS) || silentFor > SILENT_LIMIT_SECONDS;
    if (expired) {
      states.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Record that we ended an agent ourselves.
 *
 * An agent we killed sends no closing event — hooks can't report their own death
 * — so its last hook state would stand until it ages out. For most agents that
 * corrects itself, because process reconciliation sees the pid is gone. Not for a
 * daemon-hosted one: the pid its hooks reported is a pooled helper that outlives
 * the session, so the state keeps looking alive. Writing `gone` here is what
 * makes the row disappear the moment the kill succeeds, in every case.
 *
 * Returns false for an agent the store never knew (one we only ever found in
 * `ps`), which needs no marking: nothing will list it once its process is gone.
 */
export function markGone(
  states: Map<string, AgentState>,
  key: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const state = states.get(key);
  if (!state) return false;
  states.set(key, { ...state, status: 'gone', since: now, lastEventAt: now, lastEvent: 'killed' });
  return true;
}

export function foldInto(states: Map<string, AgentState>, events: AgentEvent[]): Map<string, AgentState> {
  for (const e of events) {
    const key = e.sessionId
      ? `${e.tool}:${e.sessionId}`
      : e.pane
        ? `${e.tool}:pane:${e.pane}`
        : undefined;
    if (!key) continue;
    states.set(key, reduce(states.get(key), e));
  }
  return states;
}

interface PersistedState {
  version: 1;
  savedAt: number;
  agents: AgentState[];
}

export async function loadState(): Promise<Map<string, AgentState>> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8')) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.agents)) return new Map();
    return new Map(parsed.agents.map((a) => [a.key, a]));
  } catch {
    return new Map();
  }
}

/** Atomic so a crash mid-write cannot leave an unparseable state file. */
export async function saveState(states: Map<string, AgentState>): Promise<void> {
  await ensureDirs();
  const body: PersistedState = {
    version: 1,
    savedAt: Math.floor(Date.now() / 1000),
    agents: [...states.values()],
  };
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body)}\n`, 'utf8');
  await rename(tmp, STATE_FILE);
}

export async function appendEvents(events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureDirs();
  await appendFile(EVENTS_LOG, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

/**
 * Fold pending events into `states`, then remove the files that were folded.
 *
 * Only the collector should consume: read-only callers use {@link peek} so a
 * short-lived `fw` invocation cannot eat the app's pending events.
 */
export async function consume(states: Map<string, AgentState>): Promise<number> {
  const batch = await readSpool();
  foldInto(states, batch.events);
  await appendEvents(batch.events);
  await Promise.all([...batch.files, ...batch.bad].map((f) => rm(f, { force: true })));
  const pruned = pruneStates(states);
  if (batch.events.length > 0 || pruned > 0) await saveState(states);
  return batch.events.length;
}

/** Non-destructive read: persisted state plus whatever is still in the spool. */
export async function peek(): Promise<Map<string, AgentState>> {
  const [states, batch] = await Promise.all([loadState(), readSpool()]);
  foldInto(states, batch.events);
  pruneStates(states);
  return states;
}

export interface CollectorOptions {
  /** Safety-net sweep; fs.watch misses events under load and across volumes. */
  sweepMs?: number;
  onUpdate?: (states: Map<string, AgentState>) => void;
}

/**
 * Watches the spool and keeps an in-memory state map current.
 *
 * Deliberately debounced: a single agent turn can fire a dozen hooks in a few
 * milliseconds, and folding once per burst is enough for a UI.
 */
export class Collector {
  readonly states: Map<string, AgentState>;
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private running = false;
  private readonly options: CollectorOptions;

  constructor(states: Map<string, AgentState> = new Map(), options: CollectorOptions = {}) {
    this.states = states;
    this.options = options;
  }

  static async start(options: CollectorOptions = {}): Promise<Collector> {
    await ensureDirs();
    const collector = new Collector(await loadState(), options);
    await collector.drain();
    collector.watch();
    return collector;
  }

  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const n = await consume(this.states);
      if (n > 0) this.options.onUpdate?.(this.states);
      return n;
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.drain();
    }, 60);
  }

  watch(): void {
    try {
      this.watcher = watch(SPOOL_DIR, () => this.schedule());
    } catch {
      // No inotify/FSEvents available — the sweep below covers us.
    }
    this.timer = setInterval(() => this.schedule(), this.options.sweepMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }
}
