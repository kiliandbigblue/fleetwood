export * from './types.ts';
export * from './exec.ts';
export * from './events.ts';
export * from './fleet.ts';
export * as paths from './paths.ts';
export * as tmux from './tmux.ts';
export * as proc from './procScan.ts';
export * as claudeDaemon from './claudeDaemon.ts';
export * as spool from './spool.ts';
export * as screen from './screen.ts';
export * as limits from './limits.ts';
export * as cursorUsage from './cursorUsage.ts';
export * as hooks from './hookInstall.ts';
export * as actions from './actions.ts';
export * as config from './config.ts';
export * as github from './github.ts';
export * as deployState from './deployState.ts';
export * as deployMarks from './deployMarks.ts';
export * as repoIndex from './repoIndex.ts';
export * as worktree from './worktree.ts';
export * as prSession from './prSession.ts';
export * as task from './task.ts';
export { findTrackedSessionId, findCursorChatId, resumeArgsFor } from './resume.ts';
export * as taskPrs from './taskPrs.ts';
export * as taskHistory from './taskHistory.ts';
export {
  groupPrStacks,
  partitionAgents,
  prRepoTags,
  prSummary,
  repoSummary,
  worstState,
} from './taskView.ts';
export type { Severity, StackRow } from './taskView.ts';
export { worktreeShortName } from './naming.ts';
// Flat, like the theme and switch helpers below, for the CLI and for core's own
// banding pass. The renderer imports the same module by its leaf path instead —
// a value taken off this barrel drags `fs` and `child_process` into its bundle.
// The reader is namespaced rather than flat because it is the half that opens
// files, and the distinction is worth seeing at the call site.
export { contextBand, describeContext, formatContextTokens } from './contextFormat.ts';
export type { ContextBand, ContextThresholds } from './contextFormat.ts';
export * as agentContext from './context.ts';
// Flat, because the CLI's picker renders these rows and the urgency order is
// shared with the fleet list — see switchTargets.ts.
export { agentTitle, agentUrgency, buildSwitchTargets } from './switchTargets.ts';
export type { SwitchInput, SwitchKind, SwitchTarget, SwitchTier } from './switchTargets.ts';
// Flat, for the same reason as the theme below: both front ends order and label
// sessions with these, and the renderer must not import the barrel to get them.
export {
  ORDER_STEP,
  isHidden,
  isPinned,
  nameWithHidden,
  nameWithOrder,
  nameWithPin,
  parseSessionName,
  planReorder,
  sameSession,
  sessionLabel,
  sessionOrder,
  sortSessions,
} from './sessionOrder.ts';
export type { MoveDirection, Orderable, SessionName, SessionRename } from './sessionOrder.ts';
// Flat, because both renderers paint from the same palettes and neither may
// import the barrel for them (which pulls in tmux and process scanning).
export {
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  DEFAULT_BG_OPACITY,
  MIN_BG_OPACITY,
  isThemeName,
  clampBgOpacity,
  paletteFor,
  rgbTriplet,
  withAlpha,
} from './theme.ts';

// Types consumers need by name (namespace re-exports don't surface them).
export type { PullRequest, ChecksState, PrLists } from './github.ts';
// Flat, because the renderer needs these as values and must not import the
// barrel (which pulls in tmux and process scanning).
export { isDone, needsDeploy, byUrgencyThenRecency } from './deployState.ts';
export type {
  DeployState,
  DeployRollup,
  RunRole,
  WorkflowRun,
  MergedPr,
  MergedPrs,
} from './github.ts';
export type { AgentState, AgentEvent, SpoolRecord } from './events.ts';
export type { LocalRepo, RepoIndex } from './repoIndex.ts';
export type { Worktree } from './worktree.ts';
export type { Config, MergedConfig, DeployPatterns } from './config.ts';
export type { Palette, Theme, ThemeName } from './theme.ts';
export type { Task, TaskRepo, CreateTaskInput, TaskResult } from './task.ts';
export type { BranchVia, TaskBranch, TaskBranches, TaskPr, TaskPrs } from './taskPrs.ts';
export type { ArchivedTask, ArchivedRepo, ArchivedPr } from './taskHistory.ts';
export type { ActionResult } from './actions.ts';
export type { PromptOption, ScreenRead } from './screen.ts';
export type { PlanLimits, LimitWindow } from './limits.ts';
export type { CursorUsage } from './cursorUsage.ts';
export { formatUsd } from './cursorUsage.ts';
export type { DaemonWorker } from './claudeDaemon.ts';
