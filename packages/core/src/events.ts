import type { AgentStatus, AgentTool, StatusProvenance } from './types.ts';

/**
 * What a hook script writes into the spool. Deliberately dumb: the shell does no
 * parsing, it just wraps the agent's own payload with the tmux coordinates it
 * inherited from the pane the agent was launched in.
 */
export interface SpoolRecord {
  source: AgentTool;
  /** `$TMUX_PANE` — the whole reason we can bind an agent to a pane. */
  pane?: string;
  tmux?: string;
  /** Event name for agents that pass it as an argument rather than in the payload. */
  arg?: string;
  recvAt: number;
  env?: {
    child?: string;
    sessionId?: string;
    pid?: string;
  };
  payload?: unknown;
}

/** A normalized event, agent-agnostic. */
export interface AgentEvent {
  at: number;
  tool: AgentTool;
  /** Canonical event name, e.g. 'PreToolUse'. */
  event: string;
  sessionId?: string;
  pane?: string;
  cwd?: string;
  /** Human-readable "what it's doing right now". */
  activity?: string;
  toolName?: string;
  transcript?: string;
  /**
   * The agent process's own pid, when it tells us.
   *
   * This is the rescue path for agents whose hooks run without `$TMUX_PANE` —
   * background and nested sessions, whose hook environment is detached from the
   * pane. Walking up the process tree from here finds the owning pane.
   */
  hookPid?: number;
}

export interface AgentState {
  /** Stable identity: the agent's own session id when we have one. */
  key: string;
  tool: AgentTool;
  sessionId?: string;
  pane?: string;
  cwd?: string;
  status: AgentStatus;
  provenance: StatusProvenance;
  /** When the status last *changed* — drives "blocked for 4m". */
  since: number;
  lastEventAt: number;
  lastEvent: string;
  activity?: string;
  currentTool?: string;
  transcript?: string;
  hookPid?: number;
  turns: number;
  toolCalls: number;
  errorCount: number;
  subagents: number;
  /** Filled in by process reconciliation, not by hooks. */
  pid?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncate(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Shorten a shell command from the middle, keeping both of its ends.
 *
 * Commands are the one activity whose end carries the point: a row saying
 * `Bash: cd /Users/…/tasks/print-v2-spooler-stopped-…` has spent every column
 * it had on the `cd` and thrown away the `&& pnpm test` that says what the
 * agent is actually doing. Both front ends shorten this again to fit their own
 * columns, so cutting the tail here loses it for good — which is why this is
 * upstream of them rather than in either one.
 *
 * A prompt is the opposite and still uses `truncate`: what a prompt is about is
 * in its first words.
 */
function elide(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // The verb and its first argument, against the end that names the target.
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`;
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

/**
 * A one-line summary of a tool call, which is what you actually want to read in
 * a side panel: "Bash: pnpm test" beats "PreToolUse".
 */
export function describeToolUse(toolName: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'Bash': {
      const cmd = str(o.command);
      return cmd ? `Bash: ${elide(cmd, 60)}` : 'Bash';
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const file = str(o.file_path) ?? str(o.notebook_path);
      return file ? `${toolName}: ${basename(file)}` : toolName;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(o.pattern);
      return pattern ? `${toolName}: ${truncate(pattern, 40)}` : toolName;
    }
    case 'Task': {
      const description = str(o.description) ?? str(o.subagent_type);
      return description ? `Task: ${truncate(description, 50)}` : 'Task';
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = str(o.url) ?? str(o.query);
      return target ? `${toolName}: ${truncate(target, 50)}` : toolName;
    }
    default:
      return toolName;
  }
}

/** Claude Code's `hook_event_name` values, which we treat as canonical. */
const CLAUDE_EVENTS = new Set([
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
]);

/** Cursor's hook names, mapped onto the Claude Code vocabulary. */
const CURSOR_EVENT_MAP: Record<string, string> = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  beforeShellExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  afterFileEdit: 'PostToolUse',
  beforeMCPExecution: 'PreToolUse',
  stop: 'Stop',
};

export function normalize(record: SpoolRecord): AgentEvent | undefined {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const at = record.recvAt;
  const pane = str(record.pane);
  // Note: env.child (CLAUDE_CODE_CHILD_SESSION) is NOT used to detect nesting.
  // It is inherited by any shell an agent spawns, so a plain session started
  // from inside another agent's terminal reports child=1 while being top-level.
  // Nesting is inferred later, from how the pane had to be resolved.
  const hookPid = Number.parseInt(record.env?.pid ?? '', 10) || undefined;

  if (record.source === 'claude') {
    const event = str(payload.hook_event_name) ?? str(record.arg);
    if (!event || !CLAUDE_EVENTS.has(event)) return undefined;
    const toolName = str(payload.tool_name);
    let activity: string | undefined;
    if (event === 'UserPromptSubmit') {
      const prompt = str(payload.prompt);
      if (prompt) activity = truncate(prompt, 72);
    } else if (toolName) {
      activity = describeToolUse(toolName, payload.tool_input);
    } else if (event === 'Notification') {
      activity = str(payload.message);
    }
    return {
      at,
      tool: 'claude',
      event,
      sessionId: str(payload.session_id) ?? str(record.env?.sessionId),
      pane,
      cwd: str(payload.cwd),
      activity,
      toolName,
      transcript: str(payload.transcript_path),
      hookPid,
    };
  }

  if (record.source === 'cursor') {
    const rawEvent = str(record.arg) ?? str(payload.hook_event_name) ?? str(payload.hookEventName);
    const event = rawEvent ? CURSOR_EVENT_MAP[rawEvent] : undefined;
    if (!event) return undefined;
    const command = str(payload.command);
    const prompt = str(payload.prompt);
    return {
      at,
      tool: 'cursor',
      event,
      sessionId:
        str(payload.conversation_id) ??
        str(payload.conversationId) ??
        str(payload.session_id) ??
        str(payload.chat_id) ??
        str(payload.generation_id),
      pane,
      cwd: str(payload.cwd) ?? str(payload.workspace_root),
      activity: command ? `Shell: ${truncate(command, 60)}` : prompt ? truncate(prompt, 72) : undefined,
      toolName: command ? 'Shell' : undefined,
      // Present on most hooks when transcripts are enabled. Nothing reads it
      // today; recorded so a future reader has the path without a new hook.
      transcript: str(payload.transcript_path) ?? str(payload.transcriptPath),
      hookPid,
    };
  }

  if (record.source === 'codex') {
    // Codex passes a JSON argv payload with a `type` such as "agent-turn-complete".
    const type = str(payload.type) ?? str(record.arg);
    if (!type) return undefined;
    const event = type.includes('complete') ? 'Stop' : 'PreToolUse';
    return {
      at,
      tool: 'codex',
      event,
      sessionId: str(payload.session_id) ?? str(payload['conversation-id']),
      pane,
      cwd: str(payload.cwd),
      activity: str(payload['last-assistant-message'])
        ? truncate(str(payload['last-assistant-message']) as string, 72)
        : undefined,
      transcript: undefined,
      hookPid,
    };
  }

  return undefined;
}

/**
 * Identity of an agent across events.
 *
 * Session id when the agent gives us one; otherwise the pane, which is stable
 * enough for a single agent per pane. Without either, the event is unusable.
 */
export function agentKey(e: AgentEvent): string | undefined {
  if (e.sessionId) return `${e.tool}:${e.sessionId}`;
  if (e.pane) return `${e.tool}:pane:${e.pane}`;
  return undefined;
}

function initial(key: string, e: AgentEvent): AgentState {
  return {
    key,
    tool: e.tool,
    sessionId: e.sessionId,
    pane: e.pane,
    cwd: e.cwd,
    status: 'starting',
    provenance: 'hook',
    since: e.at,
    lastEventAt: e.at,
    lastEvent: e.event,
    hookPid: e.hookPid,
    turns: 0,
    toolCalls: 0,
    errorCount: 0,
    subagents: 0,
  };
}

const STATUS_BY_EVENT: Record<string, AgentStatus | undefined> = {
  SessionStart: 'idle',
  SessionEnd: 'gone',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  PermissionRequest: 'blocked_permission',
  Notification: 'blocked_input',
  PreCompact: 'compacting',
  Stop: 'idle',
  // Subagent lifecycle changes counts, not the parent's status.
  SubagentStart: undefined,
  SubagentStop: undefined,
};

/**
 * Fold one event into an agent's state.
 *
 * Pure and total: unknown events are absorbed rather than throwing, because a
 * new agent version adding an event must never take the panel down.
 */
export function reduce(prev: AgentState | undefined, e: AgentEvent): AgentState {
  const key = agentKey(e);
  if (!key) return prev ?? initial('unknown', e);
  const state: AgentState = prev ? { ...prev } : initial(key, e);

  // Out-of-order delivery: keep the newer status, but still count the event.
  const isNewer = e.at >= state.lastEventAt;

  state.lastEvent = isNewer ? e.event : state.lastEvent;
  state.lastEventAt = Math.max(state.lastEventAt, e.at);
  state.provenance = 'hook';
  if (e.pane) state.pane = e.pane;
  if (e.cwd) state.cwd = e.cwd;
  if (e.transcript) state.transcript = e.transcript;
  if (e.sessionId) state.sessionId = e.sessionId;
  if (e.hookPid) state.hookPid = e.hookPid;

  switch (e.event) {
    case 'UserPromptSubmit':
      state.turns += 1;
      break;
    case 'PreToolUse':
      state.toolCalls += 1;
      break;
    case 'PostToolUseFailure':
      state.errorCount += 1;
      break;
    case 'SubagentStart':
      state.subagents += 1;
      break;
    case 'SubagentStop':
      state.subagents = Math.max(0, state.subagents - 1);
      break;
  }

  if (isNewer) {
    // Activity is sticky through Stop so an idle agent still shows what it last
    // did; only a new turn replaces it.
    //
    // A less specific description never displaces a more specific one: PostToolUse
    // reports the tool name with no input, so it would otherwise downgrade
    // "Bash: pnpm test" to "Bash" the moment the command finished.
    if (e.activity && !state.activity?.startsWith(e.activity)) state.activity = e.activity;
    if (e.event === 'PreToolUse' || e.event === 'PermissionRequest') {
      state.currentTool = e.toolName;
    } else if (e.event === 'Stop' || e.event === 'SessionEnd') {
      state.currentTool = undefined;
    }

    const next = STATUS_BY_EVENT[e.event];
    if (next && next !== state.status) {
      state.status = next;
      state.since = e.at;
    }
  }

  return state;
}

/** Fold a batch of events (assumed roughly ordered) into a state map. */
export function reduceAll(
  events: AgentEvent[],
  into: Map<string, AgentState> = new Map(),
): Map<string, AgentState> {
  for (const e of events) {
    const key = agentKey(e);
    if (!key) continue;
    into.set(key, reduce(into.get(key), e));
  }
  return into;
}
