import { agentsInPane, processAlive, resolvePaneForPid, scanProcesses } from './procScan.ts';
import type { ProcTable } from './procScan.ts';
import { readRoster, workerAlive } from './claudeDaemon.ts';
import type { DaemonWorker } from './claudeDaemon.ts';
import { capturePane, snapshot } from './tmux.ts';
import { peek } from './spool.ts';
import { approvalKeys, readScreen } from './screen.ts';
import type { PromptOption, ScreenRead } from './screen.ts';
import { sumUsage, usageFor } from './usage.ts';
import type { AgentUsage } from './usage.ts';
import type { AgentState } from './events.ts';
import type {
  AgentProcess,
  AgentStatus,
  AgentTool,
  PaneInfo,
  SessionInfo,
  StatusProvenance,
} from './types.ts';

export interface FleetAgent extends AgentState {
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
   * not tell which terminal is showing it. `outside-tmux` means it never had one:
   * an agent running in an IDE, which fleetwood hears from because the hooks are
   * global but which it has no business calling orphaned.
   */
  orphanReason?: 'pane-gone' | 'daemon-hosted' | 'outside-tmux';
  prompt?: { question?: string; options: PromptOption[]; approve?: string; deny?: string };
  /**
   * What this agent has spent, read from its own transcript.
   *
   * Absent rather than zero when we cannot know — an agent found only in `ps`
   * never told us its session id, and "$0.00" would read as a claim.
   */
  usage?: AgentUsage;
}

export interface FleetSession extends SessionInfo {
  agents: FleetAgent[];
  /** True when any agent here is waiting on the human. */
  needsAttention: boolean;
  /** Sum over this session's agents — what the branch is costing. */
  usage?: AgentUsage;
}

export interface FleetState {
  at: number;
  sessions: FleetSession[];
  /** Agents with no pane: gone, hosted by the daemon, or never in tmux at all. */
  orphans: FleetAgent[];
  /** Every agent above — sessions *and* orphans — so the header matches the rows. */
  counts: Record<AgentStatus, number> & { total: number; costUsd: number };
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
    costUsd: 0,
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
   * Read each agent's transcript for its token spend. Opt-in like `capture`,
   * because a cold caller pays one file read per agent; the app's reads are
   * incremental, so only what was appended since the last poll is parsed.
   */
  usage?: boolean;
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
  /** Transcript-derived spend, by agent key. Empty unless `usage` was asked for. */
  usage: Map<string, AgentUsage>;
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

  // Read every transcript once, up front and concurrently: a state can be
  // reached twice below (its pane, then the orphan sweep), and the folding is
  // cached per file anyway.
  const usage = new Map<string, AgentUsage>();
  if (options.usage) {
    await Promise.all(
      [...states.values()].map(async (state) => {
        const found = await usageFor({
          transcript: state.transcript,
          sessionId: state.sessionId,
          tool: state.tool,
        });
        if (found) usage.set(state.key, found);
      }),
    );
  }

  const ctx: Reconcile = {
    table,
    processes,
    byPane,
    claimed: new Set<string>(),
    nested,
    hosted,
    usage,
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
      usage: sumUsage(agents.map((a) => a.usage)),
    });
  }

  // Anything left over belongs to no pane. Three very different cases, and two of
  // them may well still be running, so don't declare any of them dead on sight.
  const orphans: FleetAgent[] = [];
  for (const state of states.values()) {
    if (ctx.claimed.has(state.key)) continue;
    if (state.status === 'gone') continue;

    // Silent for long enough that reporting it is just noise. pruneStates drops
    // it from the store; this stops it rendering in the meantime.
    if (now - state.lastEventAt > ORPHAN_TTL_SECONDS) continue;

    const worker = hosted.get(state.key);
    const reason: FleetAgent['orphanReason'] = state.pane
      ? 'pane-gone'
      : worker
        ? 'daemon-hosted'
        : 'outside-tmux';
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
      usage: usage.get(state.key),
    });
  }

  const counts = emptyCounts();
  for (const agent of [...fleetSessions.flatMap((s) => s.agents), ...orphans]) {
    counts[agent.status] += 1;
    counts.total += 1;
    counts.costUsd += agent.usage?.costUsd ?? 0;
  }

  return { at: now, sessions: fleetSessions, orphans, counts };
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

async function agentsForPane(pane: PaneInfo, ctx: Reconcile): Promise<FleetAgent[]> {
  const { now } = ctx;
  const processes = ctx.processes.get(pane.paneId) ?? [];
  const hooked = (ctx.byPane.get(pane.paneId) ?? []).filter((s) => s.status !== 'gone');
  const out: FleetAgent[] = [];
  const seenTools = new Set<AgentTool>();

  for (const state of hooked) {
    ctx.claimed.add(state.key);
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
        // A dead agent still spent what it spent; the transcript outlives it.
        usage: ctx.usage.get(state.key),
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
      usage: ctx.usage.get(state.key),
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
