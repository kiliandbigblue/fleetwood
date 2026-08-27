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
export * as taskPrs from './taskPrs.ts';
export { partitionAgents, prSummary, repoSummary } from './taskView.ts';
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
export type { ActionResult } from './actions.ts';
export type { PromptOption, ScreenRead } from './screen.ts';
export type { PlanLimits, LimitWindow } from './limits.ts';
export type { DaemonWorker } from './claudeDaemon.ts';
