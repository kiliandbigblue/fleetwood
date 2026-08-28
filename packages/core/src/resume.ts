import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentState } from './events.ts';
import type { AgentTool } from './types.ts';

function defaultCursorChatsDir(): string {
  return join(homedir(), '.cursor', 'chats');
}

/**
 * The session id last seen running `tool` in exactly this directory, if any.
 *
 * Backs `fw resume-agent`, which tmux-resurrect launches in place of the agent
 * it can't restart itself — resurrect only knows how to re-run a command, not
 * continue a conversation. The state store already survives a tmux restart
 * (it's fed by hooks, not by tmux), so the last thing that ran this tool in
 * this exact directory tells us what to resume. What this id actually means to
 * the tool it came from — and whether it can be handed back to that tool
 * as-is — is answered per tool in {@link resumeArgsFor}.
 */
export function findTrackedSessionId(
  states: AgentState[],
  tool: AgentTool,
  cwd: string,
): string | undefined {
  const candidates = states.filter(
    (s) => s.tool === tool && s.cwd === cwd && s.sessionId && s.status !== 'gone',
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.lastEventAt > a.lastEventAt ? b : a)).sessionId;
}

/**
 * cursor-agent's resumable chat id for a conversation id fleetwood tracked.
 *
 * The id cursor's hooks report (and the id `--resume` takes) are not the same
 * thing. Hooks report a conversation id — confirmed by checking a live one on
 * disk: it names a *subdirectory* one level inside a chat,
 * `~/.cursor/chats/<chatId>/<conversationId>/`, holding that conversation's
 * own `meta.json`. `--resume [chatId]` wants the directory one level up —
 * confirmed by resuming one directly and getting a real reply back. So this
 * walks every chat directory looking for the one that has our conversation id
 * as a child, and cross-checks that child's `meta.json.cwd` against `cwd`:
 * nothing here signs the mapping, so a name match alone (a conversation id
 * moved or reused) isn't trusted without the directory's own record of where
 * it ran agreeing too.
 */
export async function findCursorChatId(
  conversationId: string,
  cwd: string,
  chatsDir: string = defaultCursorChatsDir(),
): Promise<string | undefined> {
  let chatIds: string[];
  try {
    chatIds = await readdir(chatsDir);
  } catch {
    return undefined;
  }

  for (const chatId of chatIds) {
    const metaPath = join(chatsDir, chatId, conversationId, 'meta.json');
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { cwd?: string };
      if (meta.cwd === cwd) return chatId;
    } catch {
      // No such conversation under this chat, or an unreadable meta.json —
      // either way, not our match.
    }
  }
  return undefined;
}

/**
 * The `--resume`/`--continue`-style args a freshly (re)started pane should
 * launch with, if the last thing that ran here is known.
 *
 * Only `claude` and `cursor` resolve to something today:
 * - `claude`'s tracked session id *is* its resumable id — it's the same id
 *   its transcript file is named after (`~/.claude/projects/.../<id>.jsonl`).
 * - `cursor`'s tracked id needs translating via {@link findCursorChatId}
 *   first, since the tool and the id namespace it reports don't match.
 *
 * `codex` falls back to a plain launch: nothing here has confirmed what its
 * hooks report corresponds to, and guessing wrong means silently resuming the
 * wrong conversation (or none) rather than failing loudly.
 */
export async function resumeArgsFor(
  states: AgentState[],
  tool: AgentTool,
  cwd: string,
  cursorChatsDir?: string,
): Promise<string[]> {
  const sessionId = findTrackedSessionId(states, tool, cwd);
  if (!sessionId) return [];

  if (tool === 'claude') return ['--resume', sessionId];

  if (tool === 'cursor') {
    const chatId = await findCursorChatId(sessionId, cwd, cursorChatsDir);
    return chatId ? ['--resume', chatId] : [];
  }

  return [];
}
