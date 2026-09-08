import { isHidden, sessionLabel, sortSessions } from './sessionOrder.ts';
import type { FleetAgent, FleetSession } from './fleet.ts';
import type { LocalRepo } from './repoIndex.ts';
import type { Task } from './task.ts';

/*
 * What `prefix+g` offers, as rows.
 *
 * The binding used to be `find ~/projects ~/dotfiles -maxdepth 1 | fzf`, which
 * answers a question the fleet has since outgrown: a directory is where work
 * *could* start, and what you actually reach for all day is work already
 * running. So the list is ordered by how much it already exists — live sessions
 * (with the agent panes inside them), then tasks that have a folder but no
 * session, then plain directories that have neither.
 *
 * Pure, and the rendering lives in the CLI: this decides what is offered, in
 * what order, and what each row does when you pick it, which is the part worth
 * testing without a tmux server.
 */

/** What picking a row does. The `ref` means something different for each. */
export type SwitchKind =
  | 'session' // switch the client to a tmux session
  | 'agent' // switch to the pane one agent is running in
  | 'task' // a task with no session: make one, then switch
  | 'project'; // a directory with no session: find-or-create one, then switch

export type SwitchTier = 'live' | 'dormant' | 'project';

export interface SwitchTarget {
  kind: SwitchKind;
  tier: SwitchTier;
  /** tmux session name, pane id, task slug, or absolute path — per `kind`. */
  ref: string;
  /** The name to show: a session's label without its order prefix. */
  label: string;
  /** An agent row, indented under the session that holds it. */
  agent?: FleetAgent;
  /**
   * On a session row: the agent whose state speaks for the session, and how
   * many are running in it.
   *
   * The most urgent one, since that is the only per-agent fact a one-line
   * session row has room for — and the count is what stops the chip reading as
   * "this is all that is going on in here".
   */
  lead?: FleetAgent;
  agentCount?: number;
  /** Which tmux window that agent's pane is in, for the row to name it. */
  window?: { index: number; name: string };
  /**
   * What the agent called this conversation, from the pane's title.
   *
   * Claude Code and cursor-agent both set the terminal title to a running
   * summary of what they are doing — `Prefix+g flashing popup`, `Chronopost
   * Label Test` — and tmux hands it back as `pane_title`. It is the one label
   * in this list the agent wrote itself, and it beats everything fleetwood can
   * say about a pane: `3:claude` tells you where an agent is, and this tells you
   * which agent it is. Absent when the title is still a placeholder.
   */
  title?: string;
  attached?: boolean;
  /** Some agent in this session is waiting on the human. */
  needsAttention?: boolean;
  hidden?: boolean;
  branch?: string;
  /** Session cwd, task folder, or project path. */
  path?: string;
  /** The task this row belongs to, live session or not. */
  task?: Task;
  /** Live sessions with no agent at all — the row says so rather than nothing. */
  panes?: number;
  createdAt?: number;
}

export interface SwitchInput {
  sessions: readonly FleetSession[];
  tasks: readonly Task[];
  /**
   * Plain directories to offer, if any.
   *
   * The caller's choice rather than a flag here, because the two keys differ in
   * what they *fetch*: the projects browser has no business paying for a fleet
   * scan, and the fleet picker has none paying for a filesystem walk.
   */
  projects: readonly LocalRepo[];
  /** Include sessions marked hidden, as `--all` does everywhere else. */
  all?: boolean;
  /**
   * This machine's name, which is also tmux's *default* pane title.
   *
   * Passed in rather than read, to keep this module free of `node:` imports —
   * and needed at all because a pane whose agent has not set a title yet
   * reports the hostname, which would read as an agent called
   * `Kilians-MacBook-Pro`.
   */
  hostname?: string;
}

/**
 * Titles that are not names: what a pane says before an agent has named it.
 *
 * Each agent CLI parks its product name in the title until the conversation has
 * a subject, and tmux's own default is the hostname — so all of these mean "no
 * title yet" rather than being what this agent is doing.
 */
const PLACEHOLDER_TITLES = new Set(['claude code', 'cursor agent', 'cursor', 'codex', 'claude']);

/**
 * The agent's own name for what it is doing, or undefined if it has none.
 *
 * Leading decoration comes off — Claude Code prefixes a `✳` that is its spinner,
 * not part of the title — and so does a title that is really the pane's process
 * (`2.1.263`, `zsh`), which is what tmux reports when nothing set one.
 */
export function agentTitle(
  title: string | undefined,
  paneCommand?: string,
  hostname?: string,
): string | undefined {
  if (!title) return undefined;
  // Strip leading glyphs and whitespace, keeping the first real character.
  const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (clean.length === 0) return undefined;
  const flat = clean.toLowerCase();
  if (PLACEHOLDER_TITLES.has(flat)) return undefined;
  if (paneCommand && flat === paneCommand.toLowerCase()) return undefined;
  if (hostname && flat === hostname.toLowerCase()) return undefined;
  return clean;
}

/** An agent worth offering: a dead one is a row that goes nowhere. */
function live(agent: FleetAgent): boolean {
  return agent.status !== 'gone' && agent.pane !== undefined;
}

/**
 * Whoever needs the human first — the same order the fleet list uses.
 *
 * Exported because both this and `fw status` rank agents, and two copies of an
 * urgency order is how they come to disagree.
 */
export function agentUrgency(agent: FleetAgent): number {
  switch (agent.status) {
    case 'blocked_permission':
      return 0;
    case 'blocked_input':
      return 1;
    case 'error':
      return 2;
    case 'working':
      return 3;
    case 'compacting':
      return 4;
    case 'starting':
      return 5;
    case 'idle':
      return 6;
    case 'gone':
      return 7;
  }
}

/**
 * Whether an agent needs a row of its own beside its session's.
 *
 * One agent sitting in the session's active pane needs none: switching to the
 * session lands you on it, so a child row would be the same jump written twice.
 * Anything else does — a second agent, or a single one in a window the session
 * is not currently showing, is a jump the session row cannot make for you.
 */
function needsOwnRow(agents: FleetAgent[], activePane: string | undefined): boolean {
  if (agents.length === 0) return false;
  if (agents.length > 1) return true;
  return (agents[0] as FleetAgent).pane !== activePane;
}

function taskFor(tasks: readonly Task[], session: FleetSession): Task | undefined {
  const slug = session.meta.task;
  if (slug) {
    const stamped = tasks.find((t) => t.slug === slug);
    if (stamped) return stamped;
  }
  // A restored session loses its `@fw_task`, so fall back to the join `listTasks`
  // already made from the other side.
  return tasks.find((t) => t.session === session.name);
}

export function buildSwitchTargets(input: SwitchInput): SwitchTarget[] {
  const targets: SwitchTarget[] = [];
  const ranked = sortSessions(input.sessions);
  const sessions = input.all ? ranked : ranked.filter((s) => !isHidden(s.name));

  for (const session of sessions) {
    const task = taskFor(input.tasks, session);
    const agents = session.agents.filter(live).sort((a, b) => agentUrgency(a) - agentUrgency(b));
    const panes = session.windows.flatMap((w) => w.panes);
    const activePane = panes.find((p) => p.active)?.paneId;

    targets.push({
      kind: 'session',
      tier: 'live',
      ref: session.name,
      label: sessionLabel(session.name),
      attached: session.attached > 0,
      needsAttention: session.needsAttention,
      hidden: isHidden(session.name),
      branch: session.meta.branch,
      path: session.path,
      task,
      lead: agents[0],
      agentCount: agents.length,
      panes: panes.length,
      createdAt: session.createdAt,
    });

    if (!needsOwnRow(agents, activePane)) continue;
    for (const agent of agents) {
      const window = session.windows.find((w) => w.panes.some((p) => p.paneId === agent.pane));
      const pane = panes.find((p) => p.paneId === agent.pane);
      targets.push({
        kind: 'agent',
        tier: 'live',
        ref: agent.pane as string,
        label: sessionLabel(session.name),
        agent,
        window: window ? { index: window.index, name: window.name } : undefined,
        title: agentTitle(pane?.title, pane?.command, input.hostname),
        path: agent.cwd ?? session.path,
        task,
      });
    }
  }

  // Tasks that exist as a folder and nothing else. Picking one makes the session
  // it never had, which is the only way into it that isn't `cd`.
  for (const task of input.tasks) {
    if (task.session) continue;
    targets.push({
      kind: 'task',
      tier: 'dormant',
      ref: task.slug,
      label: task.slug,
      branch: task.branch,
      path: task.dir,
      task,
      createdAt: task.createdAt,
    });
  }

  /*
   * Plain directories, last: this is what the old binding did, and losing it
   * would mean `prefix+g` could no longer start anything that isn't already a
   * task. One with a live session is already offered above, matched by label so
   * an ordered session (`20-fleetwood`) still counts as that project's.
   */
  const taken = new Set(sessions.map((s) => sessionLabel(s.name).toLowerCase()));
  for (const project of input.projects) {
    const name = project.path.split('/').pop() ?? project.path;
    if (taken.has(name.replaceAll('.', '_').toLowerCase())) continue;
    targets.push({
      kind: 'project',
      tier: 'project',
      ref: project.path,
      label: name,
      path: project.path,
    });
  }

  return targets;
}
