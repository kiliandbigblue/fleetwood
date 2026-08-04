export * from './types.ts';
export * from './exec.ts';
export * from './events.ts';
export * from './fleet.ts';
export * as paths from './paths.ts';
export * as tmux from './tmux.ts';
export * as proc from './procScan.ts';
export * as spool from './spool.ts';
export * as screen from './screen.ts';
export * as hooks from './hookInstall.ts';
export * as actions from './actions.ts';
export * as config from './config.ts';
export * as github from './github.ts';
export * as repoIndex from './repoIndex.ts';
export * as worktree from './worktree.ts';
export * as prSession from './prSession.ts';

// Types consumers need by name (namespace re-exports don't surface them).
export type { PullRequest, ChecksState, PrLists } from './github.ts';
export type { AgentState, AgentEvent, SpoolRecord } from './events.ts';
export type { LocalRepo, RepoIndex } from './repoIndex.ts';
export type { Worktree } from './worktree.ts';
export type { Config } from './config.ts';
export type { ActionResult } from './actions.ts';
export type { PromptOption } from './screen.ts';
