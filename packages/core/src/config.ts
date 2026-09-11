import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, ensureDirs } from './paths.ts';
import { clampBgOpacity, DEFAULT_BG_OPACITY, DEFAULT_THEME, isThemeName } from './theme.ts';
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
     * Checks to leave out of a PR's summary, as a case-insensitive regex source.
     *
     * Codecov by default. `codecov/patch` goes red on any diff that lowers
     * coverage, which is advice rather than a reason not to merge — but the
     * badge lets one failure dominate on purpose, so a check that fails
     * routinely paints every PR red and the colour stops meaning anything.
     *
     * Dropped from the counts rather than counted green: a check nobody acts on
     * should not pad the passing tally either.
     *
     * Empty ignores nothing. Matched against a check run's `name` and a legacy
     * commit status's `context` alike, since codecov posts the latter.
     */
    ignoreChecksPattern: string;
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
   * How opaque the panel's own surfaces are — 1 is solid, 0.2 the floor.
   *
   * The panel's, not `fw`'s: a terminal's transparency is the terminal's setting,
   * so this is the one key here the CLI has no use for. It lives beside `theme`
   * anyway because it is the same decision — how this window sits over whatever
   * is behind it — and the slider that writes it is in the theme popover.
   *
   * Only `bg` and `panel` take the alpha. Text, accents and borders stay solid at
   * every setting: the point is to see the desktop through the window, not to
   * read the window through itself.
   */
  bgOpacity: number;
  /**
   * Plan quota — Claude's `/usage` windows, and Cursor's on-demand cycle / today.
   *
   * Off until the matching command is set, because reading either means handing
   * fleetwood a credential. There is deliberately no built-in default: fleetwood
   * does not ship a Keychain scraper of its own, so the operator says explicitly
   * where each token comes from. On macOS that is usually
   * `security find-generic-password -a "<your account>" -w -s "Claude Code-credentials"`
   * and `security find-generic-password -a cursor-user -w -s cursor-access-token`.
   */
  limits: {
    tokenCommand: string;
    cursorTokenCommand: string;
    /** The window moves in hours; polling it hard would be rude and pointless. */
    pollSeconds: number;
  };
  /**
   * Where an agent's context stops being unremarkable and starts being loud.
   *
   * Settings rather than constants because the line is a judgement about your
   * own plan and your own patience, and the cost is linear either side of it —
   * there is no natural cliff to hardcode. The defaults come off a week of
   * measured sessions: half of all consumption sat above 250k, and a turn at
   * 450k cost about four times a fresh one.
   *
   * The other candidate ceiling, Claude Code's own auto-compact window, is
   * deliberately not used: it lives in *its* settings and can be overridden per
   * launch, so fleetwood would be drawing a bar against a number it does not
   * own and cannot see.
   */
  context: {
    warnTokens: number;
    criticalTokens: number;
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
    ignoreChecksPattern: 'codecov',
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
  bgOpacity: DEFAULT_BG_OPACITY,
  limits: { tokenCommand: '', cursorTokenCommand: '', pollSeconds: 300 },
  context: { warnTokens: 250_000, criticalTokens: 450_000 },
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
      context: { ...DEFAULT_CONFIG.context, ...raw.context },
      repoGroups: { ...DEFAULT_CONFIG.repoGroups, ...raw.repoGroups },
      // Validated rather than merged: every other field degrades legibly when
      // it's wrong, but a misspelt theme name would leave both UIs with no
      // palette at all.
      theme: isThemeName(raw.theme) ? raw.theme : DEFAULT_CONFIG.theme,
      // Same reasoning, one step further: an out-of-range alpha would leave the
      // window either invisible or lying about the slider it came from.
      bgOpacity: clampBgOpacity(raw.bgOpacity),
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
 * Write one key, leaving the rest of the file exactly as written.
 *
 * Not `saveConfig({ ...(await loadConfig()), ...patch })`: that would bake every
 * current default into the file, and the whole point of the shallow merge above
 * is that a config listing only what you care about keeps picking up new ones.
 */
async function patchConfig(patch: Record<string, unknown>): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    // No file yet is fine — write one holding just this key. Anything else means
    // there is a config there we could not parse, and clobbering a config to
    // record an appearance setting is not a trade worth making.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await ensureDirs();
  await writeFile(CONFIG_FILE, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`, 'utf8');
}

/** Persist just the theme. */
export async function saveTheme(theme: ThemeName): Promise<void> {
  await patchConfig({ theme });
}

/** Persist just the background opacity, clamped, so the file can't hold a value
 *  the slider could never produce. */
export async function saveBgOpacity(bgOpacity: number): Promise<void> {
  await patchConfig({ bgOpacity: clampBgOpacity(bgOpacity) });
}
