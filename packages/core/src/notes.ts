import { readFile, rm, writeFile } from 'node:fs/promises';
import { NOTES_FILE, ensureDirs } from './paths.ts';

export { NOTES_FILE };
import type { ActionResult } from './actions.ts';

/**
 * Your own notes — the one scratchpad, not a task's.
 *
 * This is where the end of the day goes: what you were in the middle of, what
 * tomorrow starts with, the thing you must not forget to say to someone. It
 * used to live in a Raycast note beside the panel, which meant the fleet was in
 * one window and the account of it in another. A task's `NOTES.md` is not the
 * same thing: that file sits beside the worktrees so an *agent* finds it, and it
 * is about that task. This one is yours, about the whole desk, and nothing reads
 * it but you and `fw notes`.
 *
 * One file, `~/.fleetwood/notes.md`, next to the config and editable the same
 * way. Not one per day: what you want back in the morning is where you left
 * off, not a calendar of where you had been — and a note that is *always* the
 * current one can be kept open all day rather than opened at 18:55.
 */

/** The notes as they are on disk, `''` when there are none. Never trimmed:
 *  the panel keeps a cursor in this text. */
export async function readNotes(): Promise<string> {
  try {
    return await readFile(NOTES_FILE, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Replace the notes.
 *
 * Written as typed, trailing newline and all — a save runs a moment after every
 * keystroke, and trimming would move the cursor of whoever is still typing.
 * Blank removes the file, the same rule a task's notes follow: "nothing written"
 * is one state on disk rather than two.
 */
export async function writeNotes(text: string): Promise<ActionResult> {
  if (text.trim().length === 0) {
    await rm(NOTES_FILE, { force: true });
    return { ok: true, detail: 'cleared notes' };
  }
  await ensureDirs();
  await writeFile(NOTES_FILE, text, 'utf8');
  return { ok: true, detail: `saved notes (${text.trim().length} chars)` };
}
