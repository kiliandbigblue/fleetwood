/** Which agent CLI is running in a pane. */
export type AgentTool = 'claude' | 'cursor' | 'codex' | 'unknown';

/**
 * What an agent is doing right now.
 *
 * `blocked_*` are the states that mean "Kilian is the bottleneck" — they are
 * what the app exists to surface.
 */
export type AgentStatus =
  | 'starting'
  | 'idle' // registered, or turn finished and awaiting a prompt
  | 'working' // mid-turn
  | 'blocked_permission' // a permission prompt is on screen
  | 'blocked_input' // Notification: waiting on the human
  | 'compacting'
  | 'error'
  | 'gone';

/** How we learned an agent's status. Drives trust and `fw doctor` output. */
export type StatusProvenance =
  | 'hook' // an agent hook told us — precise
  | 'screen' // capture-pane heuristics — approximate
  | 'process' // a matching process exists but no hook ever fired
  | 'stale'; // last known hook state, now unverified

/** Fleetwood metadata stamped onto a tmux session as user options. */
export interface SessionMeta {
  kind?: 'project' | 'pr' | 'worktree' | 'scratch' | 'task';
  /** Comma-separated for a task, which spans several. */
  repo?: string; // "bigbluedisco/atlas"
  branch?: string;
  pr?: string; // "bigbluedisco/atlas#1234"
  worktree?: string; // absolute path
  /** Task slug, for a session working a multi-repo task. */
  task?: string;
  /** The folder holding that task's worktrees. */
  taskdir?: string;
}

export interface PaneInfo {
  paneId: string; // "%3"
  paneIndex: number;
  windowId: string; // "@1"
  sessionId: string; // "$1"
  sessionName: string;
  pid: number;
  command: string; // pane_current_command — unreliable for agents (can be a version string)
  cwd: string;
  title: string;
  active: boolean;
  width: number;
  height: number;
}

export interface WindowInfo {
  windowId: string;
  index: number;
  name: string;
  active: boolean;
  panes: PaneInfo[];
}

export interface SessionInfo {
  sessionId: string; // "$1"
  name: string;
  attached: number;
  createdAt: number; // epoch seconds
  path: string;
  meta: SessionMeta;
  windows: WindowInfo[];
}

/** A process discovered under a pane's process tree. */
export interface AgentProcess {
  pid: number;
  ppid: number;
  cpu: number;
  elapsedSeconds: number;
  command: string;
  tool: AgentTool;
}
