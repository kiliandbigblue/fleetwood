import { readFile, writeFile } from 'node:fs/promises';
import { MERGED_FILE, ensureDirs } from './paths.ts';

/**
 * Merges you have deployed by hand.
 *
 * For the Go services CI stops at a pushed image, so "it is live" is a fact only
 * you hold — this is where you put it. Marking is not hiding: the row stays, says
 * it was deployed by hand, and sinks below the ones still owed, which is what
 * makes it safe to trust the count above.
 *
 * The renderer keeps no persistent state of its own, so the file is owned by the
 * main process — the same arrangement as `window.json`. Values are the epoch
 * seconds you marked it, which is what lets the file be pruned rather than grow
 * for the lifetime of the install.
 */
export interface DeployMarksFile {
  deployed: Record<string, number>;
}

async function read(): Promise<DeployMarksFile> {
  try {
    const raw = JSON.parse(await readFile(MERGED_FILE, 'utf8')) as Partial<DeployMarksFile>;
    return { deployed: { ...raw.deployed } };
  } catch {
    return { deployed: {} };
  }
}

async function write(file: DeployMarksFile): Promise<void> {
  try {
    await ensureDirs();
    await writeFile(MERGED_FILE, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } catch {
    // Losing a mark is not worth surfacing; the row simply reads unshipped again.
  }
}

/**
 * The marks, as `prKey → when`, with anything older than `cutoffEpoch` dropped.
 *
 * Pruning on read rather than on write keeps it honest with a lookback window the
 * user can widen at any time: a mark only matters while its PR could still be
 * listed.
 */
export async function loadMarks(cutoffEpoch = 0): Promise<Map<string, number>> {
  const file = await read();
  const kept: Record<string, number> = {};
  let pruned = false;
  for (const [key, at] of Object.entries(file.deployed)) {
    if (at >= cutoffEpoch) kept[key] = at;
    else pruned = true;
  }
  if (pruned) await write({ deployed: kept });
  return new Map(Object.entries(kept));
}

/** Record that you shipped it. Keyed by `prKey`, so it survives a re-fetch. */
export async function markDeployed(key: string, at = Math.floor(Date.now() / 1000)): Promise<void> {
  const file = await read();
  file.deployed[key] = at;
  await write(file);
}

/** Take the mark back — the undo for a misclick. */
export async function unmarkDeployed(key: string): Promise<void> {
  const file = await read();
  if (!(key in file.deployed)) return;
  delete file.deployed[key];
  await write(file);
}
