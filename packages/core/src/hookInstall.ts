import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BACKUP_DIR, HOOK_DIR, ensureDirs } from './paths.ts';

/**
 * Claude Code events we register for. This set is chosen so that every status
 * transition has a trigger, including the ones that mean "you are the
 * bottleneck" (PermissionRequest, Notification).
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'PreCompact',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Cursor names events in its config, so each entry passes the name as argv. */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'beforeShellExecution',
  'afterFileEdit',
  'stop',
] as const;

export const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');
export const CURSOR_HOOKS = join(homedir(), '.cursor', 'hooks.json');
export const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml');

export interface InstallReport {
  hooksDir: string;
  scripts: string[];
  /** Set when the hook scripts could not be located at all. */
  scriptError?: string;
  claude: { path: string; added: string[]; alreadyPresent: string[]; backup?: string; error?: string };
  cursor: { path: string; added: string[]; alreadyPresent: string[]; backup?: string; skipped?: string; error?: string };
  codex: { path: string; instructions?: string; skipped?: string };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Timestamped copy before any edit. Never overwrites a previous backup. */
async function backup(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, `${path.split('/').pop()}.${stamp}`);
  await copyFile(path, target);
  return target;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.fleetwood.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/**
 * Directory of this module, when that is knowable.
 *
 * Returns undefined inside a CJS bundle: esbuild rewrites `import.meta` to `{}`,
 * so the property is simply missing rather than throwing. Callers must have a
 * fallback — the Electron app sets FLEETWOOD_HOOKS_DIR for exactly this reason.
 */
function moduleDir(): string | undefined {
  const dir = (import.meta as { dirname?: string }).dirname;
  return typeof dir === 'string' && dir.length > 0 ? dir : undefined;
}

/** Where the canonical hook scripts live, across every way we get loaded. */
async function resolveHookSource(): Promise<string | undefined> {
  const here = moduleDir();
  const candidates = [
    process.env.FLEETWOOD_HOOKS_DIR,
    // packages/core/src → packages/hooks, when Node runs the TS directly.
    here ? resolve(here, '..', '..', 'hooks') : undefined,
    // Running from a checkout.
    resolve(process.cwd(), 'packages', 'hooks'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);

  for (const candidate of candidates) {
    if (await exists(join(candidate, 'claude.sh'))) return candidate;
  }
  return undefined;
}

/**
 * Copy the hook scripts into ~/.fleetwood/hooks so installed configs don't point
 * at a checkout that might move or be deleted.
 */
export async function installScripts(): Promise<{ dir: string; scripts: string[]; error?: string }> {
  await ensureDirs();
  const source = await resolveHookSource();
  if (!source) {
    return {
      dir: HOOK_DIR,
      scripts: [],
      error: 'could not locate the hook scripts (set FLEETWOOD_HOOKS_DIR)',
    };
  }

  const names = ['claude.sh', 'cursor.sh', 'codex.sh'];
  const written: string[] = [];
  for (const name of names) {
    const from = join(source, name);
    if (!(await exists(from))) continue;
    const to = join(HOOK_DIR, name);
    await copyFile(from, to);
    await chmod(to, 0o755);
    written.push(to);
  }
  return { dir: HOOK_DIR, scripts: written };
}

interface ClaudeHookEntry {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeHookGroup[]>;
} & Record<string, unknown>;

/**
 * Register our hook in ~/.claude/settings.json.
 *
 * Adds a new matcher group per event rather than editing existing ones, so
 * peon-ping's entries are never rewritten — the file already carries several
 * groups per event, which is exactly the shape this produces.
 */
export async function installClaudeHooks(
  hookPath: string,
  settingsPath = CLAUDE_SETTINGS,
): Promise<InstallReport['claude']> {
  const result: InstallReport['claude'] = { path: settingsPath, added: [], alreadyPresent: [] };

  let settings: ClaudeSettings = {};
  if (await exists(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as ClaudeSettings;
    } catch (err) {
      result.error = `could not parse: ${(err as Error).message}`;
      return result;
    }
  }

  result.backup = await backup(settingsPath);
  const hooks = (settings.hooks ??= {});

  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = (hooks[event] ??= []);
    const present = groups.some((g) => g.hooks?.some((h) => h.command === hookPath));
    if (present) {
      result.alreadyPresent.push(event);
      continue;
    }
    groups.push({
      matcher: '',
      hooks: [{ type: 'command', command: hookPath, timeout: 5, async: true }],
    });
    result.added.push(event);
  }

  if (result.added.length > 0) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeJsonAtomic(settingsPath, settings);
  }
  return result;
}

interface CursorHookEntry {
  command: string;
  timeout?: number;
}

type CursorHooks = {
  hooks?: Record<string, CursorHookEntry[]>;
  version?: number;
} & Record<string, unknown>;

export async function installCursorHooks(
  hookPath: string,
  hooksPath = CURSOR_HOOKS,
): Promise<InstallReport['cursor']> {
  const result: InstallReport['cursor'] = { path: hooksPath, added: [], alreadyPresent: [] };

  if (!(await exists(dirname(hooksPath)))) {
    result.skipped = 'cursor-agent not configured on this machine';
    return result;
  }

  let config: CursorHooks = { version: 1 };
  if (await exists(hooksPath)) {
    try {
      config = JSON.parse(await readFile(hooksPath, 'utf8')) as CursorHooks;
    } catch (err) {
      result.error = `could not parse: ${(err as Error).message}`;
      return result;
    }
  }

  result.backup = await backup(hooksPath);
  const hooks = (config.hooks ??= {});
  config.version ??= 1;

  for (const event of CURSOR_HOOK_EVENTS) {
    const entries = (hooks[event] ??= []);
    const present = entries.some((e) => e.command?.includes(hookPath));
    if (present) {
      result.alreadyPresent.push(event);
      continue;
    }
    // Cursor shell-parses `command`, so the event name rides along as argv.
    entries.push({ command: `${hookPath} ${event}`, timeout: 5 });
    result.added.push(event);
  }

  if (result.added.length > 0) await writeJsonAtomic(hooksPath, config);
  return result;
}

/**
 * Codex is configured in TOML, which we will not rewrite blind — a bad edit
 * there breaks the agent. Report the exact line to add instead.
 */
export async function codexInstructions(hookPath: string): Promise<InstallReport['codex']> {
  if (!(await exists(dirname(CODEX_CONFIG)))) {
    return { path: CODEX_CONFIG, skipped: 'codex not installed' };
  }
  let current = '';
  try {
    current = await readFile(CODEX_CONFIG, 'utf8');
  } catch {
    // Missing file is fine; the instruction is the same.
  }
  if (current.includes(hookPath)) return { path: CODEX_CONFIG };
  return {
    path: CODEX_CONFIG,
    instructions: `notify = ["${hookPath}"]`,
  };
}

export async function installAll(): Promise<InstallReport> {
  const { dir, scripts, error } = await installScripts();
  const claudeHook = join(dir, 'claude.sh');
  const cursorHook = join(dir, 'cursor.sh');
  const codexHook = join(dir, 'codex.sh');

  const [claude, cursor, codex] = await Promise.all([
    installClaudeHooks(claudeHook),
    installCursorHooks(cursorHook),
    codexInstructions(codexHook),
  ]);

  return { hooksDir: dir, scripts, scriptError: error, claude, cursor, codex };
}

export interface HookStatus {
  claude: { installed: number; total: number };
  cursor: { installed: number; total: number; available: boolean };
}

/** Read-only view for `fw doctor`. */
export async function hookStatus(): Promise<HookStatus> {
  const claudeHook = join(HOOK_DIR, 'claude.sh');
  const cursorHook = join(HOOK_DIR, 'cursor.sh');

  let claudeInstalled = 0;
  try {
    const settings = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings;
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = settings.hooks?.[event] ?? [];
      if (groups.some((g) => g.hooks?.some((h) => h.command === claudeHook))) claudeInstalled += 1;
    }
  } catch {
    // Unreadable or absent: zero installed.
  }

  let cursorInstalled = 0;
  const cursorAvailable = await exists(CURSOR_HOOKS);
  if (cursorAvailable) {
    try {
      const config = JSON.parse(await readFile(CURSOR_HOOKS, 'utf8')) as CursorHooks;
      for (const event of CURSOR_HOOK_EVENTS) {
        const entries = config.hooks?.[event] ?? [];
        if (entries.some((e) => e.command?.includes(cursorHook))) cursorInstalled += 1;
      }
    } catch {
      // Same.
    }
  }

  return {
    claude: { installed: claudeInstalled, total: CLAUDE_HOOK_EVENTS.length },
    cursor: { installed: cursorInstalled, total: CURSOR_HOOK_EVENTS.length, available: cursorAvailable },
  };
}
