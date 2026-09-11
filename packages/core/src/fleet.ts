import { agentsInPane, processAlive, resolvePaneForPid, scanProcesses } from './procScan.ts';
import type { ProcTable } from './procScan.ts';
import { readRoster, workerAlive } from './claudeDaemon.ts';
import type { DaemonWorker } from './claudeDaemon.ts';
import { capturePane, snapshot } from './tmux.ts';
import { peek } from './spool.ts';
import { approvalKeys, readScreen } from './screen.ts';
import type { PromptOption, ScreenRead } from './screen.ts';
import type { AgentState } from './events.ts';
import { readContextTokens } from './context.ts';
import { contextBand } from './contextFormat.ts';
import type { ContextBand, ContextThresholds } from './contextFormat.ts';
import type {
  AgentProcess,
  AgentStatus,
  AgentTool,
  PaneInfo,
  SessionInfo,
  StatusProvenance,
} from './types.ts';

export interface FleetAgent extends AgentState {
  /**
   * Tokens of context this agent is carrying, off its transcript's newest turn.
   *
   * The one live number about an agent that has an action attached: it is what
   * the next turn re-reads, so a pane at 400k costs several times what the same
   * question costs in a fresh one, and `/clear` resets it. Absent unless the
   * caller asked for it, and absent for an agent whose transcript cannot be
   * read — the column has an empty state, and a guess here would be read as a
   * fact.
   */
  contextTokens?: number;
  /** Banded here rather than in each front end, so both draw the same line. */
  contextBand?: ContextBand;
  /** A matching process still exists under the pane. */
  alive: boolean;
  /** Seconds in the current status. */
  forSeconds: number;
  /**
   * `forSeconds` is the agent's uptime, not time in this status.
   *
   * Set when no event ever timed a status change — a process we only inferred
   * from `ps` has been *running* for six hours; nothing says it has been working
   * for six hours, and rendering it as though it had is how a freshly noticed
   * agent ends up reading "working 18h".
   */
  ageIsUptime?: boolean;
  /**
   * A background or spawned agent, not the one at the terminal.
   *
   * Inferred from *how* the pane was found: a top-level interactive agent's hooks
   * carry `$TMUX_PANE`, while a nested one has to be traced through the process
   * tree. That is a property of the process, unlike the
   * CLAUDE_CODE_CHILD_SESSION env var, which any spawned shell inherits.
   */
  nested: boolean;
  /**
   * The agent runs outside the pane that displays it, in `claude daemon`'s pty.
   *
   * Still the agent at the terminal — not `nested` — but its pane was matched
   * rather than reported, and killing it means killing the worker, not the pane's
   * client.
   */
  hosted?: 'daemon';
  /**
   * Why this agent isn't attached to any pane.
   *
   * `pane-gone` means it reported a pane that no longer exists — a crash or a
   * closed window. `daemon-hosted` means it runs in `claude daemon` and we could
   * not tell which terminal is showing it.
   *
   * Editor-hosted agents (Cursor in the IDE, etc.) also fire global hooks with no
   * pane, but they are dropped rather than listed: there is nothing to focus and
   * they aren't fleetwood's to manage.
   */
  orphanReason?: 'pane-gone' | 'daemon-hosted';
  prompt?: { question?: string; options: PromptOption[]; approve?: string; deny?: string };
}

export interface FleetSession extends SessionInfo {
  agents: FleetAgent[];
  /** True when any agent here is waiting on the human. */
  needsAttention: boolean;
}

export interface FleetState {
  at: number;
  sessions: FleetSession[];
  /** Agents with no pane: a closed window, or hosted by the daemon with no match. */
  orphans: FleetAgent[];
  /** Every agent above — sessions *and* orphans — so the header matches the rows. */
  counts: Record<AgentStatus, number> & { total: number };
}

/** A hook state is only trustworthy for so long without corroboration. */
const STALE_AFTER_SECONDS = 20;

/**
 * How long a pane-less agent stays on screen after its last event.
 *
 * Without this an agent that vanished without a closing event is listed forever,
 * because nothing will ever transition it again.
 */
const ORPHAN_TTL_SECONDS = 600;

function isBlocked(status: AgentStatus): boolean {
  return status === 'blocked_permission' || status === 'blocked_input';
}

function emptyCounts(): FleetState['counts'] {
  return {
    starting: 0,
    idle: 0,
    working: 0,
    blocked_permission: 0,
    blocked_input: 0,
    compacting: 0,
    error: 0,
    gone: 0,
    total: 0,
  };
}

export interface BuildOptions {
  /** Pre-folded agent states; omit to read from disk + spool. */
  states?: Map<string, AgentState>;
  /**
   * Read pane contents to resolve blocked prompts and stale states. Costs one
   * capture-pane per candidate pane, so it is opt-in for cheap callers.
   */
  capture?: boolean;
  /**
   * Read each agent's context size, banded at these thresholds.
   *
   * One option carrying both the switch and the policy: passing thresholds is
   * how you ask for the read, since a number with nowhere to be loud is not
   * worth a file handle per agent per poll. Omitted by callers that only want
   * status — `fw switch`, the action paths — which is most of them.
   */
  context?: ContextThresholds;
  now?: number;
}

/** Everything the per-pane pass needs, gathered once for the whole build. */
interface Reconcile {
  table: ProcTable;
  /** Agent processes under each pane, walked once up front. */
  processes: Map<string, AgentProcess[]>;
  byPane: Map<string, AgentState[]>;
  claimed: Set<string>;
  nested: Set<string>;
  /** Daemon-hosted states, by key — the worker process is the real agent. */
  hosted: Map<string, DaemonWorker>;
  now: number;
  capture?: boolean;
}

/**
 * Compose the whole picture: tmux structure, hook-derived agent status, and
 * process reality, reconciled.
 *
 * The sources disagree in predictable ways, and the rules below encode who wins:
 * a dead process beats any hook state, a hook beats the screen, the screen beats
 * a stale hook, and an unreadable screen beats nothing at all.
 */
export async function buildFleet(options: BuildOptions = {}): Promise<FleetState> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const [sessions, table, states, roster] = await Promise.all([
    snapshot(),
    scanProcesses(),
    options.states ? Promise.resolve(options.states) : peek(),
    readRoster(),
  ]);

  // Pane pid → pane id, for rescuing agents whose hooks had no $TMUX_PANE.
  const panes: PaneInfo[] = [];
  const panePids = new Map<number, string>();
  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        panes.push(pane);
        panePids.set(pane.pid, pane.paneId);
      }
    }
  }

  const processes = new Map<string, AgentProcess[]>();
  for (const pane of panes) processes.set(pane.paneId, agentsInPane(table, pane.pid));

  const byPane = new Map<string, AgentState[]>();
  const nested = new Set<string>();
  const paneless: AgentState[] = [];

  const attach = (pane: string, state: AgentState): void => {
    const list = byPane.get(pane);
    if (list) list.push({ ...state, pane });
    else byPane.set(pane, [{ ...state, pane }]);
  };

  for (const state of states.values()) {
    let pane = state.pane;
    if (!pane && state.hookPid !== undefined) {
      pane = resolvePaneForPid(table, state.hookPid, panePids);
      if (pane) nested.add(state.key);
    }
    if (!pane) {
      paneless.push(state);
      continue;
    }
    attach(pane, state);
  }

  // Sessions hosted by `claude daemon` are pane-less for reasons that have
  // nothing to do with being orphaned, so they get their own resolution pass.
  const hosted = new Map<string, DaemonWorker>();
  for (const state of paneless) {
    if (state.tool !== 'claude' || state.status === 'gone' || !state.sessionId) continue;
    const worker = roster.get(state.sessionId);
    if (worker && workerAlive(table, worker)) hosted.set(state.key, worker);
  }

  if (hosted.size > 0) {
    // Only panes that could be showing one: a claude is running there and no
    // hook state claims it.
    const free = panes.filter(
      (pane) =>
        (processes.get(pane.paneId) ?? []).some((p) => p.tool === 'claude') &&
        !(byPane.get(pane.paneId) ?? []).some((s) => s.tool === 'claude' && s.status !== 'gone'),
    );
    const bound = matchDaemonPanes([...hosted.values()], free);
    for (const state of paneless) {
      const worker = hosted.get(state.key);
      const pane = worker && bound.get(worker.sessionId);
      if (pane) attach(pane, state);
    }
  }

  const ctx: Reconcile = {
    table,
    processes,
    byPane,
    claimed: new Set<string>(),
    nested,
    hosted,
    now,
    capture: options.capture,
  };

  const fleetSessions: FleetSession[] = [];
  for (const session of sessions) {
    const agents: FleetAgent[] = [];
    for (const window of session.windows) {
      for (const pane of window.panes) agents.push(...(await agentsForPane(pane, ctx)));
    }
    fleetSessions.push({
      ...session,
      agents,
      needsAttention: agents.some((a) => isBlocked(a.status)),
    });
  }

  // Anything left over belongs to no pane. Two cases may still be running — a
  // closed window, or a daemon worker we couldn't place — so don't declare them
  // dead on sight. Editor-hosted agents (no pane, no daemon worker) are skipped:
  // hooks hear them, but fleetwood has nowhere to send you and nothing useful to do.
  const orphans: FleetAgent[] = [];
  for (const state of states.values()) {
    if (ctx.claimed.has(state.key)) continue;
    if (state.status === 'gone') continue;

    // Silent for long enough that reporting it is just noise. pruneStates drops
    // it from the store; this stops it rendering in the meantime.
    if (now - state.lastEventAt > ORPHAN_TTL_SECONDS) continue;

    const worker = hosted.get(state.key);
    if (!state.pane && !worker) continue;

    const reason: FleetAgent['orphanReason'] = state.pane ? 'pane-gone' : 'daemon-hosted';
    // A pid we can still see means it's alive somewhere we just can't show. For a
    // daemon session that pid is the roster's worker, never the hook's own — the
    // hook runs in a pooled helper that is spawned early and dies late.
    const alive = worker ? true : processAlive(table, state.hookPid);
    orphans.push({
      ...state,
      alive,
      nested: false,
      hosted: worker ? 'daemon' : undefined,
      pid: worker?.pid ?? state.pid,
      status: alive ? state.status : 'gone',
      orphanReason: reason,
      forSeconds: now - (alive ? state.since : state.lastEventAt),
    });
  }

  const everyAgent = [...fleetSessions.flatMap((s) => s.agents), ...orphans];
  if (options.context) await fillContext(everyAgent, options.context);

  const counts = emptyCounts();
  for (const agent of everyAgent) {
    counts[agent.status] += 1;
    counts.total += 1;
  }

  return { at: now, sessions: fleetSessions, orphans, counts };
}

/**
 * Fill in each agent's context size, in place.
 *
 * One pass over the finished list rather than a read at each of the four places
 * an agent gets constructed — and it has to be last anyway, because whether an
 * agent is `nested` is only settled by then, and that decides which of two
 * agents sharing a transcript gets the figure.
 *
 * A `gone` agent is skipped: its transcript still says how big the conversation
 * got, but there is no next turn to pay for it, and a number in that row would
 * read as something you could still act on.
 *
 * Sharing happens because a spawned agent's hooks can report its parent's
 * transcript. Printing the same figure on two rows would be wrong on one of
 * them, so the interactive agent keeps it and the nested one shows nothing —
 * blank being the column's honest answer for "not known here".
 */
async function fillContext(agents: FleetAgent[], at: ContextThresholds): Promise<void> {
  const owner = new Map<string, FleetAgent>();
  for (const agent of agents) {
    if (agent.status === 'gone' || !agent.transcript) continue;
    const held = owner.get(agent.transcript);
    if (!held) owner.set(agent.transcript, agent);
    else if (held.nested && !agent.nested) owner.set(agent.transcript, agent);
  }

  await Promise.all(
    [...owner].map(async ([path, agent]) => {
      const tokens = await readContextTokens(path);
      if (tokens === undefined) return;
      agent.contextTokens = tokens;
      agent.contextBand = contextBand(tokens, at);
    }),
  );
}

/**
 * Match daemon-hosted agents to the panes displaying them.
 *
 * The worker and its terminal share no pid, no environment and no tmux option —
 * Claude Code strips `$TMUX_PANE` from the worker and the daemon reparents it —
 * so the only evidence left is that both describe the same terminal: the
 * directory the session was launched from, and the CLI version tmux reports as
 * the pane's command.
 *
 * Ambiguity is deliberately left unresolved. Attaching the wrong worker to a
 * pane would print one agent's status against another's terminal, and the
 * approve/deny buttons act on that pane — so a match counts only when it is the
 * only candidate on *both* sides. Unmatched workers are still reported, just
 * without a pane.
 */
export function matchDaemonPanes(
  workers: DaemonWorker[],
  panes: Pick<PaneInfo, 'paneId' | 'cwd' | 'command'>[],
): Map<string, string> {
  const pairs: { sessionId: string; paneId: string }[] = [];
  for (const worker of workers) {
    for (const pane of panes) {
      if (!sharePath(worker.cwd, pane.cwd)) continue;
      if (!shareVersion(worker.cliVersion, pane.command)) continue;
      pairs.push({ sessionId: worker.sessionId, paneId: pane.paneId });
    }
  }

  const perWorker = new Map<string, number>();
  const perPane = new Map<string, number>();
  for (const pair of pairs) {
    perWorker.set(pair.sessionId, (perWorker.get(pair.sessionId) ?? 0) + 1);
    perPane.set(pair.paneId, (perPane.get(pair.paneId) ?? 0) + 1);
  }

  const bound = new Map<string, string>();
  for (const pair of pairs) {
    if (perWorker.get(pair.sessionId) !== 1 || perPane.get(pair.paneId) !== 1) continue;
    bound.set(pair.sessionId, pair.paneId);
  }
  return bound;
}

/** Same directory, or one inside the other — a pane may have been cd'd deeper. */
function sharePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * A pane whose command is a bare version must match the worker's.
 *
 * Claude Code's real pane process is its versioned binary, so tmux reports
 * `pane_current_command` as "2.1.220" — free corroboration when it's there, and
 * no evidence either way when the pane reports something else.
 */
function shareVersion(cliVersion: string | undefined, paneCommand: string): boolean {
  if (!cliVersion || !/^\d+(?:\.\d+)+$/.test(paneCommand)) return true;
  return cliVersion === paneCommand;
}

export interface ScreenVerdict {
  status: AgentStatus;
  provenance: StatusProvenance;
  prompt?: FleetAgent['prompt'];
}

/**
 * Fold a pane read into a hook-derived status.
 *
 * A permission prompt on screen is decisive whenever we see one — that is the
 * state the whole panel exists to surface. Past that, the screen only speaks for
 * a hook that has gone quiet, and only when it says something definite: an
 * unrecognised pane is not evidence, so it lowers trust and changes nothing.
 *
 * It used to promote a quiet blocked agent to `working` on an unreadable screen,
 * reasoning that the prompt must have been answered elsewhere. But "waiting for
 * your input" looks exactly like an idle prompt box — nothing on screen to read —
 * so that rule quietly relabelled every agent waiting on the human as busy,
 * which is the one mistake this tool cannot afford. A real answer arrives as the
 * next hook event a moment later anyway.
 */
export function reconcileWithScreen(
  state: { status: AgentStatus; provenance: StatusProvenance },
  read: ScreenRead,
  stale: boolean,
): ScreenVerdict {
  if (read.status === 'blocked_permission') {
    const { approve, deny } = approvalKeys(read.options);
    return {
      status: 'blocked_permission',
      // Already reported as blocked: the screen corroborates the hook, it doesn't
      // downgrade it.
      provenance: state.provenance === 'hook' && isBlocked(state.status) ? 'hook' : 'screen',
      prompt: { question: read.question, options: read.options, approve, deny },
    };
  }
  if (!stale) return { status: state.status, provenance: state.provenance };
  if (read.status) return { status: read.status, provenance: 'screen' };
  return { status: state.status, provenance: 'stale' };
}

/**
 * Cursor conversations that are subagents of another one in the same pane.
 *
 * Cursor runs a delegated subagent inside the parent's process but gives it its
 * own conversation id, and its hooks inherit the parent's `$TMUX_PANE`. So each
 * one folds into a separate `AgentState` bound to the same pane, matching the
 * same single `cursor-agent` process — and since Cursor fires no terminal hook
 * for a subagent (no `stop`, no session end), that state stays `working` until
 * it ages out of the store an hour later. Left alone, one Cursor session reads
 * as four agents, three of them finished, all pointing at the same pane.
 *
 * The parent is the one Cursor talks to the human through: only a top-level
 * conversation gets `beforeSubmitPrompt`, so only it ever counts a turn. Among
 * several that qualify — a pane reused for a second session, whose first one
 * never reported an end either — the most recent wins. Recency alone would not
 * do: a parent that has delegated everything is *quieter* than its subagents.
 *
 * Returns the keys to hide. Empty unless a pane really holds more than one.
 */
export function cursorSubagentKeys(states: AgentState[]): Set<string> {
  const cursor = states.filter((s) => s.tool === 'cursor');
  if (cursor.length < 2) return new Set();

  const withTurns = cursor.filter((s) => s.turns > 0);
  const candidates = withTurns.length > 0 ? withTurns : cursor;
  let primary = candidates[0] as AgentState;
  for (const s of candidates) if (s.lastEventAt > primary.lastEventAt) primary = s;

  return new Set(cursor.filter((s) => s.key !== primary.key).map((s) => s.key));
}

async function agentsForPane(pane: PaneInfo, ctx: Reconcile): Promise<FleetAgent[]> {
  const { now } = ctx;
  const processes = ctx.processes.get(pane.paneId) ?? [];
  const hooked = (ctx.byPane.get(pane.paneId) ?? []).filter((s) => s.status !== 'gone');
  const subagents = cursorSubagentKeys(hooked);
  const out: FleetAgent[] = [];
  const seenTools = new Set<AgentTool>();

  for (const state of hooked) {
    // Claimed even when hidden: an unclaimed state falls through to the orphan
    // sweep, which would list the subagent again with no pane at all.
    ctx.claimed.add(state.key);
    if (subagents.has(state.key)) {
      // The parent occupies the pane's cursor slot, so the process below is
      // spoken for; nothing else should adopt it as an agent that never hooked.
      seenTools.add(state.tool);
      continue;
    }
    const worker = ctx.hosted.get(state.key);
    const match = processes.find((p) => p.tool === state.tool);
    seenTools.add(state.tool);

    // A missing process is decisive: hooks can't report their own crash. Except
    // for a daemon-hosted agent, whose process is the roster's worker — the pane
    // only holds the client attached to it.
    if (!match && !worker) {
      out.push({
        ...state,
        alive: false,
        nested: ctx.nested.has(state.key),
        status: 'gone',
        forSeconds: now - state.since,
      });
      continue;
    }

    const age = now - state.lastEventAt;
    const stale = age > STALE_AFTER_SECONDS;
    let { status, provenance } = state;
    let prompt: FleetAgent['prompt'];

    if (ctx.capture && (isBlocked(status) || stale)) {
      const verdict = reconcileWithScreen(state, readScreen(await capturePane(pane.paneId, 40)), stale);
      status = verdict.status;
      provenance = verdict.provenance;
      prompt = verdict.prompt;
    } else if (stale && status === 'working') {
      provenance = 'stale';
    }

    // A status the screen just corrected starts its clock now.
    const since = status === state.status ? state.since : now;
    out.push({
      ...state,
      status,
      provenance,
      since,
      alive: true,
      nested: ctx.nested.has(state.key),
      hosted: worker ? 'daemon' : undefined,
      pid: worker?.pid ?? match?.pid,
      forSeconds: now - since,
      prompt,
    });
  }

  // A running agent that never sent a hook — usually means hooks aren't
  // installed for that tool, or it started before they were.
  for (const p of processes) {
    if (seenTools.has(p.tool)) continue;
    let status: AgentStatus = 'idle';
    let prompt: FleetAgent['prompt'];
    if (ctx.capture) {
      const read = readScreen(await capturePane(pane.paneId, 40));
      if (read.status) status = read.status;
      if (read.status === 'blocked_permission') {
        const { approve, deny } = approvalKeys(read.options);
        prompt = { question: read.question, options: read.options, approve, deny };
      }
    }
    out.push({
      key: `${p.tool}:pane:${pane.paneId}`,
      tool: p.tool,
      pane: pane.paneId,
      cwd: pane.cwd,
      status,
      provenance: ctx.capture && status !== 'idle' ? 'screen' : 'process',
      since: now - p.elapsedSeconds,
      lastEventAt: 0,
      lastEvent: 'none',
      turns: 0,
      toolCalls: 0,
      errorCount: 0,
      subagents: 0,
      alive: true,
      nested: false,
      pid: p.pid,
      forSeconds: p.elapsedSeconds,
      // Nothing timed this status: all we have is how long the process has been up.
      ageIsUptime: true,
      prompt,
    });
  }

  return out;
}
