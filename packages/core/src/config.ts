import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, ensureDirs } from './paths.ts';

export interface Config {
  /** Where to look for projects, in the order the picker should show them. */
  projectRoots: string[];
  /**
   * Where PR worktrees go, relative to the repo root.
   *
   * `.agents/worktrees` is deliberately tool-agnostic: it leaves room for other
   * agent-related state beside it without colonising `.claude/` or `.cursor/`.
   */
  worktreeDir: string;
  /** GitHub searches driving the PR lists. */
  github: {
    enabled: boolean;
    pollSeconds: number;
    /** Extra qualifiers appended to every search, e.g. 'org:bigbluedisco'. */
    extraQualifiers: string;
  };
  poll: {
    tmuxMs: number;
    processMs: number;
  };
  /** Read pane contents to resolve prompts and stale states. */
  capture: boolean;
}

export const DEFAULT_CONFIG: Config = {
  projectRoots: [join(homedir(), 'projects'), join(homedir(), 'dotfiles')],
  worktreeDir: '.agents/worktrees',
  github: { enabled: true, pollSeconds: 60, extraQualifiers: '' },
  poll: { tmuxMs: 1_000, processMs: 2_000 },
  capture: true,
};

/** Shallow-merge on purpose: a partial config file must not lose new defaults. */
export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      github: { ...DEFAULT_CONFIG.github, ...raw.github },
      poll: { ...DEFAULT_CONFIG.poll, ...raw.poll },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
