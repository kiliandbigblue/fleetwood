import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, ensureDirs } from './paths.ts';
import { DEFAULT_THEME, isThemeName } from './theme.ts';
import type { ThemeName } from './theme.ts';

/**
 * How a workflow run's name is read as deploy / build / pre-flight.
 *
 * Each is a case-insensitive regex source. `deploy` is tested first, so a job
 * called `build_and_deploy` counts as a deploy rather than a build — otherwise
 * the frontends would all read as "still needs shipping".
 *
 * `build` means specifically the run that produces the *deployable* artifact —
 * the container image. Repos like `atlas` fire several workflows off the same
 * tag, and the others publish libraries: `Copy Go bindings to atlas-proto-go`
 * pushes generated code to another repo, `Node.js Package` publishes to npm.
 * Neither is a thing you deploy, so neither may answer for the image. Matching
 * them meant the badge reported whichever of the three GitHub happened to list
 * first — they share a commit, a tag, and a second, so the order is arbitrary.
 */
export interface DeployPatterns {
  deployPattern: string;
  buildPattern: string;
  checkPattern: string;
}

export interface MergedConfig extends DeployPatterns {
  enabled: boolean;
  /** How far back to look. Older merges are nobody's open question any more. */
  lookbackHours: number;
  /** Slower than the open-PR poll: a merge's trail takes minutes, not seconds. */
  pollSeconds: number;
  /**
   * Below this age, a missing build/deploy run means "not yet", not "never".
   *
   * The chain is test → autotag → tag push → build, so there is a real window
   * after a merge where the only honest answer is "still running".
   */
  settleMinutes: number;
  /** Per-repo pattern overrides, for repos whose workflow names don't say it. */
  repos: Record<string, Partial<DeployPatterns>>;
}

export interface Config {
  /** Where to look for projects, in the order the picker should show them. */
  projectRoots: string[];
  /**
   * Where multi-repo task folders live.
   *
   * Each task folder holds one real git worktree per involved repo, so a single
   * agent rooted there can read and edit across all of them. Hidden, so it never
   * shows up in the project picker or the tmux-sessionizer's fzf.
   */
  taskRoot: string;
  /** Named repo constellations, e.g. `flow: [proto, graphy]`. */
  repoGroups: Record<string, string[]>;
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
    /**
     * The recently-merged list, and how to read a merge's CI trail.
     *
     * "Deployed" is not a fact GitHub holds for most of these repos — no
     * Deployments API entries, no job-level `environment:`. What it does hold is
     * the workflow runs attached to the merge commit, and their *names* say
     * which of the two shapes happened: a docker image was pushed (someone
     * still has to ship it), or a deploy ran (it is live). Hence patterns over
     * names rather than a per-repo table.
     */
    merged: MergedConfig;
  };
  poll: {
    tmuxMs: number;
    processMs: number;
  };
  /** Read pane contents to resolve prompts and stale states. */
  capture: boolean;
  /**
   * The editor the panel launches on a repo, typed into a fresh pane.
   *
   * A setting rather than a constant because it is the one command here that is
   * pure personal taste — and the button is labelled with whatever it says, so
   * changing it never leaves the UI lying about what the click does.
   */
  editor: string;
  /**
   * The colour theme, for the panel and for `fw` alike.
   *
   * One key rather than two because the two surfaces are looked at together: the
   * panel sits beside the terminal all day, and a `fw status` printed in Rose Pine
   * inside a Catppuccin window is the exact clash this setting exists to end.
   *
   * Written by the panel's picker, and safe to edit by hand — an unknown name
   * falls back to the default rather than painting nothing.
   */
  theme: ThemeName;
  /**
   * The plan's quota bars — the same numbers Claude Code's `/usage` shows.
   *
   * Off until `tokenCommand` is set, because reading it means handing fleetwood
   * an OAuth credential. There is deliberately no built-in default command:
   * fleetwood does not ship a Keychain scraper of its own, so the operator says
   * explicitly where the token comes from. On macOS that is usually
   * `security find-generic-password -a "<your account>" -w -s "Claude Code-credentials"`.
   */
  limits: {
    tokenCommand: string;
    /** The window moves in hours; polling it hard would be rude and pointless. */
    pollSeconds: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  projectRoots: [join(homedir(), 'projects'), join(homedir(), 'dotfiles')],
  taskRoot: join(homedir(), 'projects', '.agents', 'tasks'),
  repoGroups: {},
  worktreeDir: '.agents/worktrees',
  github: {
    enabled: true,
    pollSeconds: 60,
    extraQualifiers: '',
    merged: {
      enabled: true,
      lookbackHours: 72,
      pollSeconds: 120,
      settleMinutes: 15,
      deployPattern: 'deploy|hosting',
      buildPattern: 'docker|image|\\bbuild\\b|publish',
      checkPattern: 'test|lint|check|autotag',
      repos: {},
    },
  },
  poll: { tmuxMs: 1_000, processMs: 2_000 },
  capture: true,
  editor: 'nvim',
  theme: DEFAULT_THEME,
  limits: { tokenCommand: '', pollSeconds: 300 },
};

/** Shallow-merge on purpose: a partial config file must not lose new defaults. */
export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      github: {
        ...DEFAULT_CONFIG.github,
        ...raw.github,
        merged: { ...DEFAULT_CONFIG.github.merged, ...raw.github?.merged },
      },
      poll: { ...DEFAULT_CONFIG.poll, ...raw.poll },
      limits: { ...DEFAULT_CONFIG.limits, ...raw.limits },
      repoGroups: { ...DEFAULT_CONFIG.repoGroups, ...raw.repoGroups },
      // Validated rather than merged: every other field degrades legibly when
      // it's wrong, but a misspelt theme name would leave both UIs with no
      // palette at all.
      theme: isThemeName(raw.theme) ? raw.theme : DEFAULT_CONFIG.theme,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Persist just the theme, leaving the rest of the file exactly as written.
 *
 * Not `saveConfig({ ...(await loadConfig()), theme })`: that would bake every
 * current default into the file, and the whole point of the shallow merge above
 * is that a config listing only what you care about keeps picking up new ones.
 */
export async function saveTheme(theme: ThemeName): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    // No file yet is fine — write one holding just the theme. Anything else means
    // there is a config there we could not parse, and clobbering a config to
    // record a colour scheme is not a trade worth making.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await ensureDirs();
  await writeFile(CONFIG_FILE, `${JSON.stringify({ ...raw, theme }, null, 2)}\n`, 'utf8');
}
