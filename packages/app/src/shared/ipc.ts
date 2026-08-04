import type { ActionResult, FleetState, PrLists } from '@fleetwood/core';

/** Everything the renderer knows. Pushed whole; it is small and simplifies the UI. */
export interface Snapshot {
  fleet: FleetState;
  prs?: PrLists;
  /** Session names that fleetwood stamped, keyed by PR key, for link badges. */
  prSessions: Record<string, string>;
  hooksInstalled: boolean;
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
  | { kind: 'archiveSession'; session: string; force?: boolean }
  | { kind: 'openPr'; repo: string; number: number; branch?: string }
  | { kind: 'answerPrompt'; pane: string; key: string }
  | { kind: 'interrupt'; pane: string }
  | { kind: 'sendPrompt'; pane: string; text: string }
  | { kind: 'spawnAgent'; session: string; cwd: string; tool: 'claude' | 'cursor' | 'codex' }
  | { kind: 'openProject'; path: string }
  | { kind: 'listProjects' }
  | { kind: 'openExternal'; url: string }
  | { kind: 'installHooks' }
  | { kind: 'setAlwaysOnTop'; value: boolean };

export type Response =
  | ({ ok: boolean; detail: string } & Partial<ActionResult>)
  | { ok: true; detail: string; projects: Array<{ path: string; name: string; repo?: string }> };
