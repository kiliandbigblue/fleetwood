import type { ActionResult, FleetState, PlanLimits, PrLists, Task } from '@fleetwood/core';

/** Everything the renderer knows. Pushed whole; it is small and simplifies the UI. */
export interface Snapshot {
  fleet: FleetState;
  /** Multi-repo tasks. Refreshed on a slower cadence than the fleet — each one
   *  costs a `git status` per repo, which is not worth doing every second. */
  tasks: Task[];
  prs?: PrLists;
  /** Session names that fleetwood stamped, keyed by PR key, for link badges. */
  prSessions: Record<string, string>;
  hooksInstalled: boolean;
  /** Plan quota bars. Absent unless `limits.tokenCommand` is configured. */
  limits?: PlanLimits;
}

export const CHANNELS = {
  snapshot: 'fleetwood:snapshot',
  invoke: 'fleetwood:invoke',
} as const;

/** One request type per click the UI can make. */
export type Request =
  | { kind: 'refresh' }
  | { kind: 'refreshPrs' }
  | { kind: 'focusSession'; session: string }
  | { kind: 'focusPane'; pane: string }
  | { kind: 'killSession'; session: string }
  /** Close one agent by its fleet key — pids are resolved in main, never sent from a snapshot. */
  | { kind: 'killAgent'; key: string }
  | { kind: 'archiveSession'; session: string; force?: boolean }
  | { kind: 'openPr'; repo: string; number: number; branch?: string }
  | { kind: 'answerPrompt'; pane: string; key: string }
  | { kind: 'interrupt'; pane: string }
  | { kind: 'sendPrompt'; pane: string; text: string }
  | { kind: 'spawnAgent'; session: string; cwd: string; tool: 'claude' | 'cursor' | 'codex' }
  | { kind: 'openProject'; path: string }
  | { kind: 'listTasks' }
  | {
      kind: 'createTask';
      type: string;
      microservice: string;
      summary: string;
      goal?: string;
      repos: string[];
      branchOverrides?: Record<string, string>;
      agent?: 'claude' | 'cursor' | 'codex' | 'none';
    }
  | { kind: 'addRepoToTask'; slug: string; repo: string; branch?: string }
  | { kind: 'archiveTask'; slug: string; force?: boolean }
  | { kind: 'listProjects' }
  | { kind: 'openExternal'; url: string }
  | { kind: 'installHooks' }
  | { kind: 'setAlwaysOnTop'; value: boolean };

export type Response =
  | ({ ok: boolean; detail: string } & Partial<ActionResult>)
  | {
      ok: true;
      detail: string;
      projects: Array<{ path: string; name: string; repo?: string; isRepo: boolean }>;
    }
  | { ok: boolean; detail: string; tasks: Task[] };
