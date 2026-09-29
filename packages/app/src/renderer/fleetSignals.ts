import type { AgentStatus, FleetAgent, StatusProvenance, TaskPr } from '@fleetwood/core';

/*
 * What a card says about the agents in it, before anything else it says.
 *
 * The panel answers one question — what is every agent doing, and what needs me
 * — and a task card used to lead with a different one: how far along the task
 * is. That ring was the largest mark on the card and agent state was a 6px dot
 * two rows down, so a working agent sat under a grey "not started" ring and a
 * blocked one under the same ring as the working card above it. These are the
 * pure halves of putting the agents first: which one leads, what the lead mark
 * says, and what the row under it reads as.
 */

/**
 * Whoever needs the human is listed first.
 *
 * The order is what you would do about it: a permission prompt holds an agent
 * completely still, an error has stopped it — then the ones making progress,
 * then the ones that are not.
 */
export const AGENT_RANK: Record<AgentStatus, number> = {
  blocked_permission: 0,
  error: 2,
  working: 3,
  compacting: 4,
  starting: 5,
  idle: 6,
  gone: 7,
};

/** The agents most in need of you first, otherwise in the order they came. */
export function byUrgency<T extends Pick<FleetAgent, 'status'>>(agents: readonly T[]): T[] {
  // `sort` is stable, so two idle agents keep the order the collector gave them.
  return [...agents].sort((a, b) => AGENT_RANK[a.status] - AGENT_RANK[b.status]);
}

/**
 * How loudly a card has to ask for you. Three rungs, because there are three
 * answers: something here has stopped and needs you, something is moving, or
 * nothing is.
 *
 * There was a fourth, `warn`, for an agent "waiting on you" — which in practice
 * was an agent that had finished its turn a minute earlier, see the note on
 * `Notification` in `events.ts`. It was the rung most cards sat on and the one
 * that meant least, so it went.
 */
export type Severity = 'danger' | 'ok' | 'quiet';

/**
 * How a card with agents in it reads at a glance, from those agents alone.
 *
 * Nothing here weighs repos or pull requests — those are the task's progress,
 * which moved into the head's summary, and mixing them in is how a dirty
 * worktree used to outrank a working agent on the card's one mark.
 */
export function liveSeverity(agents: ReadonlyArray<Pick<FleetAgent, 'status'>>): Severity {
  if (agents.some((a) => a.status === 'blocked_permission' || a.status === 'error')) return 'danger';
  if (agents.some((a) => a.status === 'working' || a.status === 'compacting')) return 'ok';
  return 'quiet';
}

/**
 * The words the head says when an agent on the card is stopped on you.
 *
 * `undefined` otherwise — the head says nothing about an agent that needs
 * nothing, which is what keeps these few words loud when they do appear.
 */
export function needsYouLabel(agents: ReadonlyArray<Pick<FleetAgent, 'status'>>): string | undefined {
  const permission = agents.filter((a) => a.status === 'blocked_permission').length;
  if (permission > 0) return permission === 1 ? 'needs permission' : `${permission} need permission`;
  return undefined;
}

/** The lead mark, in words — for its tooltip and for a screen reader. */
export const SEVERITY_NOTE: Record<Severity, string> = {
  danger: 'an agent here is blocked on you',
  ok: 'an agent here is working',
  quiet: 'every agent here is idle',
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  blocked_permission: 'needs permission',
  compacting: 'compacting',
  idle: 'idle',
  starting: 'starting',
  error: 'error',
  gone: 'gone',
};

/**
 * What an agent row says it is doing.
 *
 * The collector keeps an agent's last activity after its turn ends — the last
 * thing the agent said, often `done` — and the row used to print it in place of
 * the status. So a finished agent read `claude done` beside a grey dot, and next
 * to a status bar counting two agents working it read as a contradiction. While
 * the agent is live the activity *is* the status, said more precisely; once it
 * is not, the status leads and the last words follow it.
 */
export function agentLabel(agent: Pick<FleetAgent, 'status' | 'activity'>): string {
  const status = AGENT_STATUS_LABEL[agent.status];
  if (!agent.activity) return status;
  const live =
    agent.status === 'working' ||
    agent.status === 'compacting' ||
    agent.status === 'blocked_permission';
  return live ? agent.activity : `${status} · ${agent.activity}`;
}

/**
 * A parked task's pull requests, in the one phrase its folded card has room for.
 *
 * The most pressing state wins: someone asked for changes, then checks failing
 * — both are work that has come back — then an approval waiting to be merged.
 * Past those, only how many are open — and a list that has all landed says so.
 */
export function prHeadline(prs: readonly TaskPr[]): string | undefined {
  // No `state` means a search result, and every search here is filtered to open.
  const open = prs.filter((pr) => pr.state !== 'MERGED');
  const count = (n: number, what: string): string => `${n} ${what}`;
  const changes = open.filter((pr) => pr.reviewDecision === 'CHANGES_REQUESTED').length;
  if (changes > 0) return count(changes, 'changes requested');
  const failing = open.filter((pr) => pr.checks === 'failing').length;
  if (failing > 0) return count(failing, 'failing');
  const approved = open.filter((pr) => pr.reviewDecision === 'APPROVED').length;
  if (approved > 0) return count(approved, 'approved');
  if (open.length > 0) return count(open.length, 'open');
  return prs.length > 0 ? 'all merged' : undefined;
}

/**
 * The card a `j`/`k` press lands on, from the one that has focus now.
 *
 * `-1` is nothing focused yet: down starts at the top and up at the bottom, the
 * way a list you have not entered is entered. The ends hold rather than wrap —
 * wrapping from the last card to the first reads as the list having jumped.
 */
export function stepIndex(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + direction));
}

/**
 * How a status was learned, when it was not reported — the mark it wears.
 *
 * The panel's first promise is that an inference never looks as solid as a
 * report, and until this the difference lived only in the dot's tooltip: an
 * agent whose hook had died still read as a confident `working`. A reported
 * status wears nothing — it is the ordinary case — and the other three wear
 * the marks the CLI has always printed.
 */
export const PROVENANCE_MARK: Record<StatusProvenance, { mark: string; note: string } | undefined> = {
  hook: undefined,
  screen: { mark: '~', note: 'read off the pane, not reported' },
  process: { mark: '?', note: 'a process is running but sent no hooks' },
  stale: { mark: '…', note: 'last reported a while ago, unconfirmed' },
};

/**
 * Whether answering with this option grants something that outlives the prompt.
 *
 * "Yes, and don't ask again" is a standing permission: once the key reaches the
 * terminal it cannot be taken back, and it sits one key over from a plain yes —
 * and, on the keyboard, from `j`/`k`. These take a second press; the one-off
 * answers do not.
 */
export function grantsLastingPermission(label: string): boolean {
  return /don['’]t ask|always|(during|for) (this|the) session|all future/i.test(label);
}

/** An agent stopped on a permission prompt, as the announcement names it. */
export interface BlockedAgent {
  key: string;
  card: string;
  activity?: string;
}

/**
 * What to say out loud when agents newly stop on you.
 *
 * Only the ones that were not blocked on the previous snapshot — the list is
 * redrawn every second, and announcing every blocked agent on every redraw
 * would drown the one that just arrived. `undefined` when nothing is new.
 */
export function blockedAnnouncement(
  previous: ReadonlySet<string>,
  now: readonly BlockedAgent[],
): string | undefined {
  const fresh = now.filter((agent) => !previous.has(agent.key));
  if (fresh.length === 0) return undefined;
  const lines = fresh.map((agent) => `${agent.card} needs permission${agent.activity ? `: ${agent.activity}` : ''}`);
  return `${lines.join('. ')}. Press n to go to it.`;
}
