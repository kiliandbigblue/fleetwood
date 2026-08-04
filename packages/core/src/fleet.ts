import { agentsInPane, processAlive, resolvePaneForPid, scanProcesses } from './procScan.ts';
import type { ProcTable } from './procScan.ts';
import { capturePane, snapshot } from './tmux.ts';
import { peek } from './spool.ts';
import { approvalKeys, readScreen } from './screen.ts';
import type { PromptOption } from './screen.ts';
import type { AgentState } from './events.ts';
import type { AgentStatus, AgentTool, PaneInfo, SessionInfo } from './types.ts';

export interface FleetAgent extends AgentState {
  /** A matching process still exists under the pane. */
  alive: boolean;
  /** Seconds in the current status. */
  forSeconds: number;
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
   * Why this agent isn't attached to any pane.
   *
   * `pane-gone` means it reported a pane that no longer exists — a crash or a
   * closed window. `outside-tmux` means it never had one: an agent running in an
   * IDE, which fleetwood hears from because the hooks are global but which it has
   * no business calling orphaned.
   */
  orphanReason?: 'pane-gone' | 'outside-tmux';
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
  /** Agents we know about whose pane is gone (or that ran outside tmux). */
  orphans: FleetAgent[];
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
  now?: number;
}

/**
 * Compose the whole picture: tmux structure, hook-derived agent status, and
 * process reality, reconciled.
 *
 * The three sources disagree in predictable ways, and the rules below encode who
 * wins: a dead process beats any hook state, a hook beats the screen, and the
 * screen beats a stale hook.
 */
export async function buildFleet(options: BuildOptions = {}): Promise<FleetState> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const [sessions, table, states] = await Promise.all([
    snapshot(),
    scanProcesses(),
    options.states ? Promise.resolve(options.states) : peek(),
  ]);

  // Pane pid → pane id, for rescuing agents whose hooks had no $TMUX_PANE.
  const panePids = new Map<number, string>();
  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) panePids.set(pane.pid, pane.paneId);
    }
  }

  const byPane = new Map<string, AgentState[]>();
  const nested = new Set<string>();
  for (const state of states.values()) {
    let pane = state.pane;
    if (!pane && state.hookPid !== undefined) {
      pane = resolvePaneForPid(table, state.hookPid, panePids);
      if (pane) nested.add(state.key);
    }
    if (!pane) continue;
    const list = byPane.get(pane);
    if (list) list.push({ ...state, pane });
    else byPane.set(pane, [{ ...state, pane }]);
  }

  const claimed = new Set<string>();
  const fleetSessions: FleetSession[] = [];
  const counts = emptyCounts();

  for (const session of sessions) {
    const agents: FleetAgent[] = [];
    for (const window of session.windows) {
      for (const pane of window.panes) {
        agents.push(...(await agentsForPane(pane, table, byPane, claimed, nested, now, options.capture)));
      }
    }
    for (const agent of agents) {
      counts[agent.status] += 1;
      counts.total += 1;
    }
    fleetSessions.push({
      ...session,
      agents,
      needsAttention: agents.some((a) => isBlocked(a.status)),
    });
  }

  // Anything left over belongs to no pane. Two very different cases, and one of
  // them may well still be running, so don't declare either one dead on sight.
  const orphans: FleetAgent[] = [];
  for (const state of states.values()) {
    if (claimed.has(state.key)) continue;
    if (state.status === 'gone') continue;

    // Silent for long enough that reporting it is just noise. pruneStates drops
    // it from the store; this stops it rendering in the meantime.
    if (now - state.lastEventAt > ORPHAN_TTL_SECONDS) continue;

    const reason: FleetAgent['orphanReason'] = state.pane ? 'pane-gone' : 'outside-tmux';
    // A pid we can still see means it's alive somewhere we just can't show.
    const alive = processAlive(table, state.hookPid);
    orphans.push({
      ...state,
      alive,
      nested: false,
      status: alive ? state.status : 'gone',
      orphanReason: reason,
      forSeconds: now - (alive ? state.since : state.lastEventAt),
    });
  }

  return { at: now, sessions: fleetSessions, orphans, counts };
}

async function agentsForPane(
  pane: PaneInfo,
  table: ProcTable,
  byPane: Map<string, AgentState[]>,
  claimed: Set<string>,
  nested: Set<string>,
  now: number,
  capture: boolean | undefined,
): Promise<FleetAgent[]> {
  const processes = agentsInPane(table, pane.pid);
  const hooked = (byPane.get(pane.paneId) ?? []).filter((s) => s.status !== 'gone');
  const out: FleetAgent[] = [];
  const seenTools = new Set<AgentTool>();

  for (const state of hooked) {
    claimed.add(state.key);
    const match = processes.find((p) => p.tool === state.tool);
    seenTools.add(state.tool);

    // A missing process is decisive: hooks can't report their own crash.
    if (!match) {
      out.push({ ...state, alive: false, nested: nested.has(state.key), status: 'gone', forSeconds: now - state.since });
      continue;
    }

    let status = state.status;
    let provenance = state.provenance;
    let prompt: FleetAgent['prompt'];

    const age = now - state.lastEventAt;
    const wantScreen = capture && (isBlocked(status) || age > STALE_AFTER_SECONDS);

    if (wantScreen) {
      const read = readScreen(await capturePane(pane.paneId, 40));
      if (read.status === 'blocked_permission') {
        status = 'blocked_permission';
        provenance = state.provenance === 'hook' && isBlocked(state.status) ? 'hook' : 'screen';
        const { approve, deny } = approvalKeys(read.options);
        prompt = { question: read.question, options: read.options, approve, deny };
      } else if (age > STALE_AFTER_SECONDS) {
        if (read.status) {
          status = read.status;
          provenance = 'screen';
        } else if (isBlocked(status)) {
          // The prompt is gone from the screen, so it was answered elsewhere.
          status = 'working';
          provenance = 'screen';
        } else {
          provenance = 'stale';
        }
      }
    } else if (age > STALE_AFTER_SECONDS && status === 'working') {
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
      nested: nested.has(state.key),
      pid: match.pid,
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
    if (capture) {
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
      provenance: capture && status !== 'idle' ? 'screen' : 'process',
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
      prompt,
    });
  }

  return out;
}
