import type {
  ActionResult,
  FleetState,
  MergedPrs,
  PlanLimits,
  PrLists,
  Task,
  TaskPrs,
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
  /**
   * The pull requests each task has open, keyed by slug.
   *
   * Not part of `Task` because a task is a folder read from disk and this is a
   * network fact on a much slower clock — folding it in would either stall the
   * task read or leave half of every `Task` stale.
   */
  taskPrs?: TaskPrs;
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
  /**
   * How opaque the window's own surfaces are, 0.2–1.
   *
   * Alongside the theme and for the same reason: dropped into the config by hand
   * it lands on the next poll, and the picker's slider is only ever the fast path
   * to the same key.
   */
  bgOpacity: number;
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
  /**
   * Move a session up or down the fleet, by renaming its order prefix.
   *
   * `order` is the list of session names as the panel is currently drawing them,
   * because that is what the click was made against: "up" means "above the card
   * above this one", and only the renderer knows what that is. Main replans from
   * it rather than re-deriving an order the user may not be looking at.
   */
  | {
      kind: 'reorderSession';
      session: string;
      direction: 'up' | 'down' | 'top' | 'bottom';
      order: string[];
    }
  /**
   * Take a session out of the ordering: the prefix comes off the tmux name.
   *
   * The way back, and not the same thing as moving it last — an unnumbered
   * session is ranked by what it is doing again, which is what the panel did
   * before anyone pinned anything.
   */
  | { kind: 'clearSessionOrder'; session: string }
  /**
   * Hold a session in the top tier, or let it go — a `+` on the tmux name.
   *
   * Separate from `reorderSession` because it is not a position: the session
   * keeps the slot it had, and what changes is which tier the moves happen
   * inside. Unpinning drops it back among the unpinned at its own number.
   */
  | { kind: 'setSessionPinned'; session: string; pinned: boolean }
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
  /**
   * Give a task that has none a tmux session — optionally with an agent in it.
   *
   * A task with no session has no name to pass to `spawnAgent` or `openEditor`,
   * so this is what every button on a dormant task's card goes through first.
   */
  | { kind: 'startTaskSession'; slug: string; agent?: 'claude' | 'cursor' | 'codex' | 'none' }
  | { kind: 'addRepoToTask'; slug: string; repo: string; branch?: string }
  /** Replace a task's NOTES.md. Empty text clears it. */
  | { kind: 'setTaskNotes'; slug: string; notes: string }
  /** Editor in a fresh pane of an existing session, on one repo's worktree. */
  | { kind: 'openEditor'; session: string; cwd: string; name?: string }
  /**
   * difit review server on one repo's worktree; difit opens the browser.
   *
   * No session, unlike `openEditor`: difit is spawned straight from main and the
   * review is read in a browser, so this works on a task that has never been
   * started. `base` is the head pull request's own base branch when the snapshot
   * holds one — the only record of what a stacked layer sits on — and main falls
   * back to the repo's trunk without it.
   */
  | { kind: 'openDifit'; cwd: string; base?: string }
  | { kind: 'archiveTask'; slug: string; force?: boolean }
  | { kind: 'listProjects' }
  | { kind: 'openExternal'; url: string }
  | { kind: 'installHooks' }
  | { kind: 'setAlwaysOnTop'; value: boolean }
  /** Repaint, and remember it: written to the config the CLI reads too. */
  | { kind: 'setTheme'; theme: ThemeName }
  /** How much of the desktop shows through. App-only — `fw` has no window. */
  | { kind: 'setBgOpacity'; value: number };

export type Response =
  | ({ ok: boolean; detail: string } & Partial<ActionResult>)
  | {
      ok: true;
      detail: string;
      projects: Array<{ path: string; name: string; repo?: string; isRepo: boolean }>;
    }
  | { ok: boolean; detail: string; tasks: Task[] };
