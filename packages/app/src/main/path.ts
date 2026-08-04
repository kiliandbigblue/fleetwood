import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Directories a GUI-launched app would otherwise never see.
 *
 * Launched from Finder, Spotlight or the Dock, a macOS app inherits launchd's
 * PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — not the one from your shell profile.
 * Fleetwood shells out to tmux, git, gh and open, and Homebrew's are in
 * /opt/homebrew/bin, so without this the packaged app finds no tmux at all and
 * reports an empty fleet.
 */
const LIKELY_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin'),
];

function dedupe(parts: string[]): string[] {
  const seen = new Set<string>();
  return parts.filter((p) => {
    if (p.length === 0 || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/** Ask the login shell what PATH it would use. Authoritative, but not guaranteed. */
function loginShellPath(timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? '/bin/zsh';
    // -l so profile files run; -i because that is where most PATH edits live.
    execFile(shell, ['-lic', 'printf %s "$PATH"'], { timeout: timeoutMs }, (error, stdout) => {
      const value = (stdout ?? '').trim();
      resolve(!error && value.includes('/') ? value : undefined);
    });
  });
}

/**
 * Make PATH usable however the app was started.
 *
 * The static list is applied immediately so nothing depends on the shell probe
 * succeeding; the probe then adds anything unusual (asdf, mise, custom prefixes)
 * when it works. Called before the first tmux read.
 */
export async function repairPath(timeoutMs = 1_500): Promise<string> {
  const current = (process.env.PATH ?? '').split(':');
  process.env.PATH = dedupe([...LIKELY_PATHS, ...current]).join(':');

  const fromShell = await loginShellPath(timeoutMs);
  if (fromShell) {
    process.env.PATH = dedupe([
      ...fromShell.split(':'),
      ...(process.env.PATH ?? '').split(':'),
    ]).join(':');
  }
  return process.env.PATH;
}
