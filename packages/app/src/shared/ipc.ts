import type {
  ActionResult,
  FleetState,
  MergedPrs,
  PlanLimits,
  PrLists,
  Task,
  ThemeName,
} from '@fleetwood/core';

/** Everything the renderer knows. Pushed whole; it is small and simplifies the UI. */
export interface Snapshot {
  fleet: FleetState;
  /** Multi-repo tasks. Refreshed on a slower cadence than the fleet — each one
   *  costs a `git status` per repo, which is not worth doing every second. */
  tasks: Task[];
  prs?: PrLists;
  /**
   * Merged inside the lookback window, with what CI did with the merge commit.
   *
   * Already ordered and already carrying your hand-marks, so the header pill and
   * the list cannot disagree about how much is still owed.
   */
  merged?: MergedPrs;
  /** Session names that fleetwood stamped, keyed by PR key, for link badges. */
  prSessions: Record<string, string>;
  hooksInstalled: boolean;
  /** The editor `openEditor` will run, so the button says what it does. */
  editor: string;
  /**
   * The configured colour theme.
   *
   * Pushed with everything else rather than fetched once at boot, so a theme
   * changed in `~/.fleetwood/config.json` by hand — or by another window — lands
   * on the next poll without a relaunch.
   */
  theme: ThemeName;
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
  /** `force` drops the cache, so even terminal rows are re-queried. */
  | { kind: 'refreshMerged'; force?: boolean }
  /** "I shipped this" — the fact CI cannot know for a manually deployed image. */
  | { kind: 'markPrDeployed'; key: string }
  | { kind: 'unmarkPrDeployed'; key: string }
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
  /** Replace a task's NOTES.md. Empty text clears it. */
  | { kind: 'setTaskNotes'; slug: string; notes: string }
  /** Editor in a fresh pane of an existing session, on one repo's worktree. */
  | { kind: 'openEditor'; session: string; cwd: string; name?: string }
  | { kind: 'archiveTask'; slug: string; force?: boolean }
  | { kind: 'listProjects' }
  | { kind: 'openExternal'; url: string }
  | { kind: 'installHooks' }
  | { kind: 'setAlwaysOnTop'; value: boolean }
  /** Repaint, and remember it: written to the config the CLI reads too. */
  | { kind: 'setTheme'; theme: ThemeName };

export type Response =
  | ({ ok: boolean; detail: string } & Partial<ActionResult>)
  | {
      ok: true;
      detail: string;
      projects: Array<{ path: string; name: string; repo?: string; isRepo: boolean }>;
    }
  | { ok: boolean; detail: string; tasks: Task[] };
