import { taskStatus } from './taskStatus.ts';
import { isMerged } from './taskView.ts';
import type { FleetAgent } from './fleet.ts';
import type { Task } from './task.ts';
import type { TaskPr } from './taskPrs.ts';
import type { TaskStatus } from './taskStatus.ts';

/*
 * How a plan reads — a Notion milestone, drawn against the tasks working it.
 *
 * A leaf module for the reason `taskView.ts` and `taskStatus.ts` are leaves: the
 * renderer draws all of this, and `task.ts` and `notion.ts` reach for `node:fs`,
 * tmux and the network, which fail the renderer bundle. Type-only imports, so
 * nothing above comes with them. Fetching is `notion.ts`; this only reads what
 * it brought back.
 *
 * Fleetwood keeps no ticket list of its own. The milestone's tickets are read
 * from Notion every time, and the only join made here is the `DEV-NNNN` in a
 * task's slug or branch — the same id the branch carries to GitHub, which is how
 * Notion links the pull request back to the ticket without being told.
 */

/**
 * The ticket a task works, off its slug or its branch.
 *
 * Case-insensitive, and returned upper-case: fw branches carry `dev-1735`
 * because `slugify` lowers everything, while Notion and every pull request seen
 * linked so far write `DEV-1735`. Bounded on the left, so a word that merely
 * ends in `dev` (`kdev-2`) is not read as a ticket.
 */
export function ticketIdOf(text: string): string | undefined {
  return ticketIdsIn(text)[0];
}

/**
 * Every ticket id in a run of text, in order, by the same rule as `ticketIdOf` —
 * so a `Blocked by` line and a branch name can never disagree on what an id is.
 */
export function ticketIdsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[^a-z0-9])dev-(\d+)/gi)].map((match) => `DEV-${match[1]}`);
}

/**
 * One entry of a ticket's `**Blocked by:**` line.
 *
 * Two shapes, because the line is written two ways. `/to-tickets` writes the
 * other ticket as a page mention, which reaches the API as a page id and the
 * page's title — no `DEV-NNNN` anywhere in it. A line typed by hand writes the
 * id. Either is resolved against the milestone's tickets; one that matches none
 * of them stays as written and reads `(unknown)`.
 */
export interface Blocker {
  /** `DEV-1721`, when the line typed the id. */
  id?: string;
  /** The mentioned page, without dashes — the form `Ticket.pageId` is kept in. */
  pageId?: string;
  /** The mentioned page's title, the only name an unknown mention has. */
  title?: string;
}

/** One ticket of a milestone, as Notion holds it. Nothing here is Fleetwood's. */
export interface Ticket {
  /** The Notion page, without dashes — what a mention on another ticket names. */
  pageId: string;
  /** `DEV-1735`, always upper-case. */
  id: string;
  /** The Notion card. */
  url: string;
  title: string;
  /** The board's own column: `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`. */
  notionStatus: string;
  assignees: Array<{ id: string; name: string }>;
  /**
   * Whether the `GitHub Pull Requests` relation holds anything.
   *
   * A yes or no rather than the pull requests: the integration cannot read the
   * GitHub database those pages live in, so the relation is ids and nothing else.
   * It is still the one record of a pull request for a ticket nobody here has a
   * task for — enough to make a blocker count as stackable.
   */
  hasPr: boolean;
  blockers: Blocker[];
  /** The page body as plain text — the goal a task started from it opens with. */
  body: string;
}

/** A Notion milestone and every ticket in it. */
export interface Plan {
  /** Without dashes, like `Ticket.pageId`. */
  milestoneId: string;
  name: string;
  url: string;
  tickets: Ticket[];
}

/**
 * Every plan the fleet has a task in, on Notion's slow clock.
 *
 * Kept across a failed fetch and flagged `stale`, like the quota gauges: a plan
 * that blanks on one flaky request reads as the milestone having emptied.
 */
export interface Plans {
  plans: Plan[];
  /** Epoch seconds. */
  fetchedAt: number;
  stale?: boolean;
}

/**
 * What Fleetwood knows about a ticket that Notion does not: the task working it.
 *
 * Assembled by the caller from the snapshot — the task, its pull requests, and
 * the agents in its session — so this module never has to know where any of
 * them came from.
 */
export interface TicketLink {
  task: Pick<Task, 'slug' | 'repos'> & Partial<Pick<Task, 'session'>>;
  /** Absent while the first pull request search is out, as on a task card. */
  prs?: TaskPr[];
  agents: Array<Pick<FleetAgent, 'status'>>;
}

/**
 * The board's columns on Fleetwood's rungs.
 *
 * Canceled is `done` rather than its own state: what the plan asks of a ticket is
 * whether anything still waits on it, and nothing waits on a canceled one. A
 * column this does not know reads `not-started`, the rung that claims nothing.
 */
const NOTION_STATUS: Record<string, TaskStatus> = {
  todo: 'not-started',
  'in progress': 'wip',
  'in review': 'in-review',
  done: 'done',
  canceled: 'done',
};

export function notionStatus(name: string): TaskStatus {
  return NOTION_STATUS[name.trim().toLowerCase()] ?? 'not-started';
}

/**
 * How far along a ticket is, and whether the board says something else.
 *
 * A ticket with a task reads Fleetwood's own status — the mark its task card
 * already draws, off its worktrees and its pull requests — because that is read
 * from the work, while the board is moved by hand and by an integration that
 * lags it. **Drift** is the two disagreeing. It is shown, with a link to the
 * card, and never written back: the board is the team's, not this panel's.
 *
 * A ticket with no task here reads the board, pull request or not. The spec
 * would have Fleetwood's status for a ticket with a pull request too, but
 * Fleetwood holds no pull request for a ticket it has no task for — the
 * `GitHub Pull Requests` relation is ids the integration cannot open — so the
 * board is the only reading there is, and a reading cannot drift from itself.
 */
export function ticketStatus(ticket: Ticket, link?: TicketLink): { status: TaskStatus; drift: boolean } {
  const board = notionStatus(ticket.notionStatus);
  if (!link) return { status: board, drift: false };
  const status = taskStatus(link.task.repos, link.prs);
  // While the first pull request search is out the reading is the worktrees
  // alone and settles upward as it lands — a ticket in review would flash a
  // drift marker for the length of one search. Nothing is claimed until it lands.
  return { status, drift: link.prs !== undefined && status !== board };
}

/**
 * Where a ticket sits in the drawer. Ordered, and the order is the whole type.
 *
 * What you can act on comes first — what is waiting on you, then what you can
 * pick up next, then what you could start stacked on a pull request still in
 * review — and what needs nothing of you goes last. That order is the question
 * the drawer exists to answer: what do I pick up next.
 */
export type TicketGroup = 'needs-you' | 'startable' | 'stackable' | 'in-progress' | 'in-review' | 'blocked' | 'done';

export const TICKET_GROUPS: readonly TicketGroup[] = [
  'needs-you',
  'startable',
  'stackable',
  'in-progress',
  'in-review',
  'blocked',
  'done',
];

/** One entry of a ticket's `Blocked by`, matched against the milestone. */
export interface ResolvedBlocker {
  /** `DEV-1721`, or a mention's title when it matched no ticket here. */
  label: string;
  /** The ticket it names. Absent when it is outside the milestone — unknown. */
  ticket?: Ticket;
  status?: TaskStatus;
  hasPr?: boolean;
}

/** One ticket, with everything the drawer says about it. */
export interface PlanTicket {
  ticket: Ticket;
  link?: TicketLink;
  status: TaskStatus;
  drift: boolean;
  /** On Notion's relation or among the linked task's pull requests. */
  hasPr: boolean;
  group: TicketGroup;
  blockers: ResolvedBlocker[];
}

/**
 * Every ticket of a plan, read against the tasks working it.
 *
 * Blocking is only asked of a ticket nobody has started — once work exists, the
 * ticket is in progress whatever its line says, because someone already decided
 * it could go. Of the rest:
 *
 * - **startable**: every blocker merged.
 * - **stackable**: every blocker has at least a pull request, so the work can be
 *   cut from the blocker's branch and stacked on it.
 * - **blocked**: anything else, including a blocker outside the milestone. That
 *   one is not fetched — it would be a page read per stray mention on every
 *   poll — so nothing can say it merged, and it reads `(unknown)`.
 *
 * `links` is keyed by `DEV-NNNN`; see `linkTickets`.
 */
export function readPlan(plan: Plan, links: ReadonlyMap<string, TicketLink>): PlanTicket[] {
  const facts = new Map(
    plan.tickets.map((ticket) => {
      const link = links.get(ticket.id);
      const hasPr = ticket.hasPr || (link?.prs?.length ?? 0) > 0;
      return [ticket.id, { ticket, link, hasPr, ...ticketStatus(ticket, link) }];
    }),
  );
  const byPage = new Map(plan.tickets.map((ticket) => [ticket.pageId, ticket]));

  return plan.tickets.map((ticket) => {
    const own = facts.get(ticket.id) as NonNullable<ReturnType<typeof facts.get>>;
    const blockers = ticket.blockers.map((blocker): ResolvedBlocker => {
      const named =
        (blocker.id !== undefined ? plan.tickets.find((t) => t.id === blocker.id) : undefined) ??
        (blocker.pageId !== undefined ? byPage.get(blocker.pageId) : undefined);
      const fact = named ? facts.get(named.id) : undefined;
      if (!named || !fact) return { label: blocker.id ?? blocker.title ?? '?' };
      return { label: named.id, ticket: named, status: fact.status, hasPr: fact.hasPr };
    });
    return {
      ticket,
      link: own.link,
      status: own.status,
      drift: own.drift,
      hasPr: own.hasPr,
      group: needsYou(own.link) ? 'needs-you' : groupOf(own.status, blockers),
      blockers,
    };
  });
}

/**
 * Whether a ticket is waiting on you, whatever else it is.
 *
 * Three things, and all three are errands only you can run: an agent stopped
 * on a permission prompt, a reviewer asking for changes, a red check. An idle
 * agent is not one of them — it finished its turn, and the card already says so
 * — and neither is a merged pull request's last check run, which is history.
 */
function needsYou(link: TicketLink | undefined): boolean {
  if (!link) return false;
  if (link.agents.some((agent) => agent.status === 'blocked_permission')) return true;
  return (link.prs ?? []).some(
    (pr) => !isMerged(pr) && (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.checks === 'failing'),
  );
}

function groupOf(status: TaskStatus, blockers: ResolvedBlocker[]): TicketGroup {
  switch (status) {
    case 'wip':
      return 'in-progress';
    case 'in-review':
      return 'in-review';
    case 'done':
      return 'done';
    case 'not-started':
      if (blockers.every((b) => b.status === 'done')) return 'startable';
      if (blockers.every((b) => b.status === 'done' || b.hasPr === true)) return 'stackable';
      return 'blocked';
  }
}

/**
 * The drawer's sections, in `TICKET_GROUPS` order, mine first in each.
 *
 * "Mine" is worked out rather than configured. A ticket I have a task for is
 * mine; so is one assigned to whoever the tickets I have tasks for are assigned
 * to. The integration token is a bot, so Notion's own "me" is the bot, and a
 * setting naming yourself would be one more thing to get wrong — whereas the
 * tickets you are already working say who you are on this board.
 *
 * Stable within a section otherwise: the milestone's own order is the order the
 * spec cut the tickets in, which is usually the order they are meant to land.
 */
export function groupTickets(rows: readonly PlanTicket[]): Array<{ group: TicketGroup; tickets: PlanTicket[] }> {
  const me = new Set(rows.filter((row) => row.link).flatMap((row) => row.ticket.assignees.map((a) => a.id)));
  const isMine = (row: PlanTicket): boolean =>
    row.link !== undefined || row.ticket.assignees.some((assignee) => me.has(assignee.id));
  return TICKET_GROUPS.map((group) => {
    const inGroup = rows.filter((row) => row.group === group);
    return { group, tickets: [...inGroup.filter(isMine), ...inGroup.filter((row) => !isMine(row))] };
  }).filter((section) => section.tickets.length > 0);
}

/**
 * The plan's row in the fleet list, in one line.
 *
 * `merged` over the whole milestone, so the count reads as progress through the
 * spec rather than through the part of it you happen to have tasks for. Then
 * only the two numbers that ask something of you, and each only when it is not
 * zero — the shape `prSummary` gives a task's pull requests, for the same reason.
 */
export function planSummary(plan: Pick<Plan, 'name'>, rows: readonly PlanTicket[]): string {
  const { progress, needsYou } = planCounts(rows);
  return [plan.name, progress, ...(needsYou > 0 ? [`${needsYou} needs you`] : [])].join(' · ');
}

/**
 * The same line in the pieces the fleet row draws apart: the name is the card's
 * title, `needs you` is said where every card says it, and the rest is the
 * caption on the gutter. One count, so the row and the drawer cannot disagree.
 */
export function planCounts(rows: readonly PlanTicket[]): { progress: string; needsYou: number } {
  // A canceled ticket unblocks like a done one, but nothing of it merged — so it
  // leaves the count altogether rather than padding progress through the spec.
  const counted = rows.filter((row) => row.ticket.notionStatus.trim().toLowerCase() !== 'canceled');
  const done = counted.filter((row) => row.status === 'done').length;
  const startable = rows.filter((row) => row.group === 'startable').length;
  const parts = [`${done}/${counted.length} merged`];
  if (startable > 0) parts.push(`${startable} startable`);
  return { progress: parts.join(' · '), needsYou: rows.filter((row) => row.group === 'needs-you').length };
}

/**
 * Every ticket the fleet has a task for, keyed by `DEV-NNNN`.
 *
 * The slug first, then the branch: a task's slug is its branch less the type,
 * so the two normally agree, and the branch only speaks for a task whose slug
 * was cut differently. Two tasks on one ticket keep the first — the drawer has
 * room for one task link per ticket, and a second task on the same ticket is
 * already one too many to be the usual case.
 *
 * `agents` is keyed by session name, which is what `Task.session` holds.
 */
export function linkTickets(
  tasks: ReadonlyArray<TicketLink['task'] & Pick<Task, 'branch'>>,
  prsByTask: Readonly<Record<string, TaskPr[]>> | undefined,
  agentsBySession: Readonly<Record<string, TicketLink['agents']>>,
): Map<string, TicketLink> {
  const links = new Map<string, TicketLink>();
  for (const task of tasks) {
    const id = ticketIdOf(task.slug) ?? ticketIdOf(task.branch);
    if (!id || links.has(id)) continue;
    links.set(id, {
      task,
      prs: prsByTask?.[task.slug],
      agents: task.session ? (agentsBySession[task.session] ?? []) : [],
    });
  }
  return links;
}

/**
 * An agent that is doing something, or is stopped on you.
 *
 * What keeps a task in view under a collapsed plan. An idle agent is left out
 * on purpose: nearly every task has a Claude sitting at its prompt, and counting
 * those would leave a collapsed plan exactly as long as the flood it replaced.
 */
export function hasLiveAgent(agents: ReadonlyArray<Pick<FleetAgent, 'status'>>): boolean {
  return agents.some(
    (agent) =>
      agent.status === 'working' ||
      agent.status === 'blocked_permission' ||
      agent.status === 'compacting' ||
      agent.status === 'starting',
  );
}

/** One row of the fleet list: an item drawn as today, or a plan with its items under it. */
export type FleetRow<T> =
  | { kind: 'item'; item: T }
  | {
      kind: 'plan';
      plan: Plan;
      /** Every item of the plan, in list order. */
      items: T[];
      /** What is drawn under the row: all of them open, only the live ones collapsed. */
      shown: T[];
    };

/**
 * The fleet list with each plan's tasks folded under one row.
 *
 * The row stands where the plan's first task stood, the rule `groupPrStacks`
 * uses for a stack, so a plan keeps the slot you put its work in and nothing
 * unrelated moves because its neighbours folded. Collapsed by default —
 * `expanded` holds the milestones opened — and a task with a live agent stays in
 * view either way, because a plan row is somewhere to put work away, not
 * somewhere to lose an agent that is running.
 *
 * Generic over the item, so the renderer can fold sessions and dormant tasks
 * alike; `idOf` says which ticket an item works, and an item with none, or one
 * no plan holds, is drawn as it always was.
 */
export function foldFleet<T>(
  items: readonly T[],
  plans: readonly Plan[],
  idOf: (item: T) => string | undefined,
  isLive: (item: T) => boolean,
  expanded: ReadonlySet<string>,
): Array<FleetRow<T>> {
  const planOf = new Map<string, Plan>();
  for (const plan of plans) for (const ticket of plan.tickets) planOf.set(ticket.id, plan);

  const rows: Array<FleetRow<T>> = [];
  const byPlan = new Map<string, Extract<FleetRow<T>, { kind: 'plan' }>>();
  for (const item of items) {
    const id = idOf(item);
    const plan = id ? planOf.get(id) : undefined;
    if (!plan) {
      rows.push({ kind: 'item', item });
      continue;
    }
    let row = byPlan.get(plan.milestoneId);
    if (!row) {
      row = { kind: 'plan', plan, items: [], shown: [] };
      byPlan.set(plan.milestoneId, row);
      rows.push(row);
    }
    row.items.push(item);
    if (expanded.has(plan.milestoneId) || isLive(item)) row.shown.push(item);
  }
  return rows;
}

/**
 * The items a folded list actually draws, in the order it draws them.
 *
 * What the arranging keys move within: a move is "above the card above this
 * one", and a card folded under a collapsed plan is not above anything on
 * screen — counting it would swap a card with one you cannot see.
 */
export function shownItems<T>(rows: ReadonlyArray<FleetRow<T>>): T[] {
  return rows.flatMap((row) => (row.kind === 'item' ? [row.item] : row.shown));
}
