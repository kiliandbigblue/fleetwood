import type {
  ActionResult,
  ArchivedTask,
  FleetState,
  MergedPrs,
  CursorUsage,
  PlanLimits,
  PrLists,
  ShutdownConfig,
  ShutdownState,
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
  /** Claude plan quota bars. Absent unless `limits.tokenCommand` is configured. */
  limits?: PlanLimits;
  /** Cursor included / seat / today. Absent unless `limits.cursorTokenCommand` is set. */
  cursorUsage?: CursorUsage;
  /**
   * The end-of-day shutdown: the schedule, and how close it is.
   *
   * Always present, off or on — the power tab is a form, and a form whose fields
   * appear only once something is scheduled has nothing to schedule it with. The
   * countdown in it is drawn from `at` against the renderer's own clock rather
   * than from `msLeft`, which is only ever as fresh as the last snapshot.
   */
  shutdown: ShutdownState;
  /**
   * Tasks that have been archived, most recent first.
   *
   * Read from disk rather than derived, and only changes when something is
   * archived — so unlike `tasks` it costs a single file read, and unlike
   * `taskPrs` nothing about it can go stale: the rows are frozen snapshots.
   */
  history: ArchivedTask[];
  /**
   * Your notes, as they are on disk — see `core/notes.ts`.
   *
   * On the snapshot rather than fetched when the drawer opens, so a line added
   * with an editor lands in the panel on the next poll, the same way a hand
   * edit of the config does.
   */
  notes: string;
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
  /**
   * Take a session out of the fleet list, or put it back — a `-` on the tmux
   * name, in front of the pin.
   *
   * Not a filter the window remembers: the marker is on the session, so a
   * session hidden here is hidden in `fw status` too and is still hidden after a
   * relaunch. The tier and the slot both survive it, so unhiding puts the card
   * back where it was rather than at the end.
   */
  | { kind: 'setSessionHidden'; session: string; hidden: boolean }
  | { kind: 'openPr'; repo: string; number: number; branch?: string }
  /**
   * The same thing for a pull request no list holds — ⌘K on a pasted URL.
   *
   * A ref rather than a parsed repo and number, so the one parser in core is
   * what decides what a pull request URL is; the renderer only tests whether it
   * has one in hand, to know whether to offer the row.
   */
  | { kind: 'openPrRef'; ref: string }
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
  /**
   * Drop one worktree from a task and keep the task — the landed-PR case.
   *
   * Named by the worktree's directory, which is the only unique handle: a stacked
   * task holds several worktrees of one repo. `force` discards uncommitted work,
   * so the card asks twice before sending it.
   */
  | { kind: 'removeRepoFromTask'; slug: string; repo: string; force?: boolean }
  /** Replace a task's NOTES.md. Empty text clears it. */
  | { kind: 'setTaskNotes'; slug: string; notes: string }
  /** Editor in a fresh pane of an existing session, on one repo's worktree. */
  | { kind: 'openEditor'; session: string; cwd: string; name?: string }
  /** The nvim review — codediff on uncommitted changes — in a fresh pane, on one repo's worktree. */
  | { kind: 'openReview'; session: string; cwd: string; name?: string }
  | { kind: 'archiveTask'; slug: string; force?: boolean }
  | { kind: 'listProjects' }
  | { kind: 'openExternal'; url: string }
  | { kind: 'installHooks' }
  | { kind: 'setAlwaysOnTop'; value: boolean }
  /** Repaint, and remember it: written to the config the CLI reads too. */
  | { kind: 'setTheme'; theme: ThemeName }
  /** How much of the desktop shows through. App-only — `fw` has no window. */
  | { kind: 'setBgOpacity'; value: number }
  /**
   * Set the end-of-day shutdown — the opt-in, the time, and the warning.
   *
   * Whole rather than per-field, because the three are one decision and a
   * half-applied one would arm a shutdown for a time you were still typing. Main
   * re-arms from it immediately, so the answer already carries the new schedule.
   */
  | { kind: 'setShutdown'; shutdown: ShutdownConfig }
  /**
   * Take the full-screen warning down. The shutdown still happens.
   *
   * Sent by the warning window itself, which is the only place it can be sent
   * from — it is the thing on screen. "I know", not "not tonight": opting out is
   * the power tab, deliberately somewhere else.
   */
  | { kind: 'dismissShutdownWarning' }
  /** Replace the notes. Sent half a second after every keystroke — see `Notes`. */
  | { kind: 'setNotes'; notes: string }
  /** The notes in the configured editor, in a window of the session you are at. */
  | { kind: 'openNotesInEditor' };

export type Response =
  | ({ ok: boolean; detail: string } & Partial<ActionResult>)
  | {
      ok: true;
      detail: string;
      projects: Array<{ path: string; name: string; repo?: string; isRepo: boolean }>;
    }
  | { ok: boolean; detail: string; tasks: Task[] };
