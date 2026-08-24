import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Overridable so tests never touch the real ~/.fleetwood. */
export const FW_HOME = process.env.FLEETWOOD_HOME ?? join(homedir(), '.fleetwood');

/** Hook scripts drop raw event payloads here; the collector folds them. */
export const SPOOL_DIR = join(FW_HOME, 'spool');
/** Append-only history, for the activity feed and for debugging. */
export const EVENTS_LOG = join(FW_HOME, 'events.jsonl');
/** Cache only — tmux user options are the source of truth for session metadata. */
export const STATE_FILE = join(FW_HOME, 'state.json');
export const CONFIG_FILE = join(FW_HOME, 'config.json');
/**
 * Which merges you deployed by hand.
 *
 * CI cannot know it, and renderer state is in-memory only, so the fact has to
 * live in a file owned by the main process — same arrangement as `window.json`.
 */
export const MERGED_FILE = join(FW_HOME, 'merged.json');
/** Timestamped copies of any user config we touch, before we touch it. */
export const BACKUP_DIR = join(FW_HOME, 'backups');
export const HOOK_DIR = join(FW_HOME, 'hooks');
export const LOG_FILE = join(FW_HOME, 'fleetwood.log');

export async function ensureDirs(): Promise<void> {
  await Promise.all([
    mkdir(SPOOL_DIR, { recursive: true }),
    mkdir(BACKUP_DIR, { recursive: true }),
    mkdir(HOOK_DIR, { recursive: true }),
  ]);
}
