import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcTable } from './procScan.ts';

/**
 * Claude Code sessions that don't live in a terminal.
 *
 * Since 2.1.x a session can be hosted by `claude daemon`: the agent runs inside
 * a pty the daemon owns (`claude bg-pty-host` / `bg-spare`), and whatever
 * displays it — a tmux pane, the desktop app — is a thin client attached over a
 * unix socket. Fleetwood's two usual bindings both fail on those:
 *
 * - `$TMUX_PANE` is stripped from the worker's environment, so hooks arrive with
 *   no pane.
 * - the worker is reparented to init when its daemon generation restarts, so
 *   walking up the process tree stops at pid 1 instead of reaching a pane.
 *
 * Worse, `$CLAUDE_PID` in that environment is the pooled `bg-spare` helper, not
 * the agent: it is spawned ahead of time and outlives the session, so "is that
 * pid still alive?" answers yes long after the agent is gone.
 *
 * The daemon's own roster is the way out. It is the registry the daemon keeps of
 * its live workers, so it maps a session id — which hooks *do* report — onto the
 * process the agent really runs in.
 */

/** Claude Code's config directory, honouring the same override the CLI does. */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

export const ROSTER_FILE = join(CLAUDE_HOME, 'daemon', 'roster.json');

export interface DaemonWorker {
  sessionId: string;
  /** The pty-host process the agent actually runs in. */
  pid: number;
  /** Where the session was launched, which is a pane's path when a pane spawned it. */
  cwd?: string;
  /** Reported as a bare version, the same string tmux shows as `pane_current_command`. */
  cliVersion?: string;
  startedAt?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the roster's workers, keyed by session id.
 *
 * Tolerant by design: this is another program's private file, so a shape change
 * or a half-written read has to degrade to "no daemon sessions known" rather
 * than take the panel down.
 */
export function parseRoster(text: string): Map<string, DaemonWorker> {
  const workers = new Map<string, DaemonWorker>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return workers;
  }
  const bag = (parsed as { workers?: unknown } | null)?.workers;
  if (typeof bag !== 'object' || bag === null) return workers;

  for (const entry of Object.values(bag as Record<string, unknown>)) {
    const worker = (entry ?? {}) as Record<string, unknown>;
    const sessionId = str(worker.sessionId);
    const pid = typeof worker.pid === 'number' ? worker.pid : undefined;
    if (!sessionId || pid === undefined || pid <= 0) continue;
    workers.set(sessionId, {
      sessionId,
      pid,
      cwd: str(worker.cwd),
      cliVersion: str(worker.cliVersion),
      startedAt: typeof worker.startedAt === 'number' ? worker.startedAt : undefined,
    });
  }
  return workers;
}

export async function readRoster(file: string = ROSTER_FILE): Promise<Map<string, DaemonWorker>> {
  try {
    return parseRoster(await readFile(file, 'utf8'));
  } catch {
    // No daemon has ever run here, or the file is being rewritten. Either way
    // there is nothing to reconcile against.
    return new Map();
  }
}

/**
 * Is a rostered worker still the process it claims to be?
 *
 * The roster keeps entries for workers that have exited, so the pid alone would
 * resurrect dead sessions. Checking the command line too costs nothing — the
 * process table is already in hand — and rules out a recycled pid.
 */
export function workerAlive(table: ProcTable, worker: DaemonWorker): boolean {
  const row = table.byPid.get(worker.pid);
  if (!row) return false;
  return /(?:^|\/)claude\b|\/\.local\/share\/claude\/versions\//.test(row.command);
}
