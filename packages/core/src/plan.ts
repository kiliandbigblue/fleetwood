import { isDone } from './deployState.ts';
import { taskRungs } from './taskStatus.ts';
import { isMerged, prKey } from './taskView.ts';
import type { DeployFact } from './deployState.ts';
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
  /**
   * The milestone's own `Progress`, 0–100, as Notion computes it — weighted by
   * the tickets' estimates, so it is the number the team reads on the board,
   * not a ticket count. Absent when the formula gave no number.
   */
  progress?: number;
  /** `Target date`, `YYYY-MM-DD`. */
  targetDate?: string;
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
 * Where a ticket sits in the drawer. Ordered, and the order is the whole type.
 *
 * What you can act on comes first — what is waiting on you, then what you can
 * pick up next, then what you could start stacked on a pull request still in
 * review — and what needs nothing of you goes last. That order is the question
 * the drawer exists to answer: what do I pick up next.
 */
export type TicketGroup =
  | 'needs-you'
  | 'startable'
  | 'stackable'
  | 'in-progress'
  | 'in-review'
  | 'merged'
  | 'blocked'
  | 'done';

export const TICKET_GROUPS: readonly TicketGroup[] = [
  'needs-you',
  'startable',
  'stackable',
  'in-progress',
  'in-review',
  'merged',
  'blocked',
  'done',
];

/**
 * Every stage a ticket can be at, from the board's first column to running in
 * production, and everything the drawer derives from one: the words it says,
 * the section it sits in, and the rung of a task card's mark it draws.
 *
 * The one model. A ticket's section is read off its stage rather than worked
 * out beside it, so the two can never disagree.
 *
 * Listed least advanced first, which is how `rollUp` reads a ticket with
 * several pull requests. The errands come last: they are the stages only you
 * can move, they sit under `needs you`, and they win a roll-up outright rather
 * than being compared.
 */
export const STAGE = {
  todo: { label: 'todo', group: 'startable', status: 'not-started' },
  stackable: { label: 'stackable', group: 'stackable', status: 'not-started' },
  blocked: { label: 'blocked', group: 'blocked', status: 'not-started' },
  started: { label: 'started, no PR yet', group: 'in-progress', status: 'wip' },
  draft: { label: 'draft PR', group: 'in-progress', status: 'wip' },
  'in-review': { label: 'in review', group: 'in-review', status: 'in-review' },
  merged: { label: 'merged', group: 'merged', status: 'done' },
  deploying: { label: 'deploying', group: 'merged', status: 'done' },
  deployed: { label: 'deployed', group: 'done', status: 'done' },
  canceled: { label: 'canceled', group: 'done', status: 'done' },
  changes: { label: 'changes requested', group: 'needs-you', status: 'in-review' },
  failing: { label: 'checks failing', group: 'needs-you', status: 'in-review' },
  built: { label: 'image built, deploy it', group: 'needs-you', status: 'done' },
  'deploy-failed': { label: 'deploy failed', group: 'needs-you', status: 'done' },
} as const satisfies Record<string, { label: string; group: TicketGroup; status: TaskStatus }>;

export type TicketStage = keyof typeof STAGE;

const ORDER = Object.keys(STAGE) as TicketStage[];

/** A stage only you can move — see `STAGE`. */
function isErrand(stage: TicketStage): boolean {
  return STAGE[stage].group === 'needs-you';
}

/** The recently-merged list, by pull request — what `readPlan` looks deploys up in. */
export function deploysByPr<T extends DeployFact & { repo: string; number: number }>(
  merged: readonly T[] | undefined,
): Map<string, DeployFact> {
  return new Map((merged ?? []).map((pr) => [prKey(pr.repo, pr.number), pr]));
}

/**
 * How long a merge stays in the recently-merged list, which is the only place a
 * deploy is read from. Past it, a merge reads `deployed`: by then it almost
 * always is, and "merged" for weeks would read as stuck.
 *
 * ponytail: the default `lookbackHours`, not the configured one; pass the config
 * through if the window is ever changed.
 */
const DEPLOY_WINDOW_MS = 72 * 3_600_000;

function prStage(pr: TaskPr, deploys: ReadonlyMap<string, DeployFact>, now: number): TicketStage {
  if (!isMerged(pr)) {
    // A change request outranks the draft flag: a reviewer asked something of you.
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
    if (pr.checks === 'failing') return 'failing';
    return pr.isDraft ? 'draft' : 'in-review';
  }
  const fact = deploys.get(prKey(pr.repo, pr.number));
  if (!fact) {
    const at = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
    return now - at > DEPLOY_WINDOW_MS ? 'deployed' : 'merged';
  }
  if (isDone(fact)) return 'deployed';
  switch (fact.deploy.state) {
    case 'built':
      return 'built';
    case 'failed':
      return 'deploy-failed';
    // No CI on the merge commit: nothing will ever say it went out.
    case 'none':
      return 'merged';
    default:
      return 'deploying';
  }
}

/** An errand if there is one — a red check on one half is the news — else the least advanced. */
function rollUp(stages: readonly TicketStage[]): TicketStage {
  const errand = stages.find(isErrand);
  if (errand) return errand;
  return stages.reduce((a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b));
}

/**
 * How far along a ticket is, before its blockers are asked about — so never
 * `stackable` or `blocked`; see `readPlan`.
 *
 * A ticket with a task reads the work, walked the way a task card's mark walks
 * it (`taskRungs`), and a merged pull request on to its deploy. The board is
 * moved by hand and lags it; it is not consulted, and not corrected either,
 * because it is the team's.
 *
 * A ticket with no task here reads the board: Fleetwood holds no pull request
 * for it, so `Done` is the most there is to say, and it reads `deployed` by the
 * same reasoning as an old merge.
 */
export function ticketStage(
  ticket: Ticket,
  link: TicketLink | undefined,
  deploys: ReadonlyMap<string, DeployFact> = new Map(),
  now = Date.now(),
): TicketStage {
  const board = ticket.notionStatus.trim().toLowerCase();
  if (board === 'canceled') return 'canceled';
  if (!link) {
    if (board === 'in progress') return 'started';
    if (board === 'in review') return 'in-review';
    if (board === 'done') return 'deployed';
    return 'todo';
  }
  const stages = taskRungs<TicketStage>(link.task.repos, link.prs, {
    pr: (pr) => prStage(pr, deploys, now),
    // A repo landed straight on the trunk has no pull request to follow to a deploy.
    repo: (status) => (status === 'done' ? 'merged' : 'started'),
  });
  return stages.length > 0 ? rollUp(stages) : 'todo';
}

/**
 * What a ticket nobody has started waits on.
 *
 * Only asked of `todo` — once work exists, the ticket is moving whatever its
 * line says, because someone already decided it could go. `undefined` is a
 * blocker outside the milestone: it is not fetched, so nothing can say it landed.
 */
function waitingOn(
  stage: TicketStage,
  blockers: ReadonlyArray<{ stage: TicketStage; hasPr: boolean } | undefined>,
): TicketStage {
  if (stage !== 'todo') return stage;
  const landed = (b: (typeof blockers)[number]): boolean => b !== undefined && STAGE[b.stage].status === 'done';
  if (blockers.every(landed)) return 'todo';
  if (blockers.every((b) => landed(b) || b?.hasPr === true)) return 'stackable';
  return 'blocked';
}

/** One entry of a ticket's `Blocked by`, matched against the milestone. */
export interface ResolvedBlocker {
  /** `DEV-1721`, or a mention's title when it matched no ticket here. */
  label: string;
  /** The ticket it names. Absent when it is outside the milestone — unknown. */
  ticket?: Ticket;
  stage?: TicketStage;
}

/** One ticket, with everything the drawer says about it. */
export interface PlanTicket {
  ticket: Ticket;
  link?: TicketLink;
  stage: TicketStage;
  /** The linked task's pull requests; the drawer names the count past one. */
  prCount: number;
  group: TicketGroup;
  blockers: ResolvedBlocker[];
}

/**
 * Every ticket of a plan, read against the tasks working it.
 *
 * Two passes, because a ticket's stage depends on its blockers' stages: first
 * each ticket on its own work, then each `todo` against what it waits on —
 *
 * - **todo** (startable): every blocker landed.
 * - **stackable**: every blocker has at least a pull request, so the work can be
 *   cut from the blocker's branch and stacked on it.
 * - **blocked**: anything else, including a blocker outside the milestone,
 *   which reads `(unknown)`.
 *
 * The section is the stage's, except for an agent stopped on a permission
 * prompt — the one errand no stage of the work can say. An idle agent is not
 * one: it finished its turn, and the card already says so.
 *
 * `links` is keyed by `DEV-NNNN`; see `linkTickets`.
 */
export function readPlan(
  plan: Plan,
  links: ReadonlyMap<string, TicketLink>,
  deploys: ReadonlyMap<string, DeployFact> = new Map(),
  now = Date.now(),
): PlanTicket[] {
  const byId = new Map(plan.tickets.map((ticket) => [ticket.id, ticket]));
  const byPage = new Map(plan.tickets.map((ticket) => [ticket.pageId, ticket]));
  const named = (blocker: Blocker): Ticket | undefined =>
    (blocker.id !== undefined ? byId.get(blocker.id) : undefined) ??
    (blocker.pageId !== undefined ? byPage.get(blocker.pageId) : undefined);

  const own = plan.tickets.map((ticket) => {
    const link = links.get(ticket.id);
    const hasPr = ticket.hasPr || (link?.prs?.length ?? 0) > 0;
    return { ticket, link, hasPr, stage: ticketStage(ticket, link, deploys, now) };
  });
  const ownOf = new Map(own.map((fact) => [fact.ticket.id, fact]));
  const read = own.map((fact) => ({
    ...fact,
    stage: waitingOn(
      fact.stage,
      fact.ticket.blockers.map((blocker) => {
        const ticket = named(blocker);
        return ticket && ownOf.get(ticket.id);
      }),
    ),
  }));
  const stageOf = new Map(read.map((fact) => [fact.ticket.id, fact.stage]));

  return read.map(({ ticket, link, stage }) => ({
    ticket,
    link,
    stage,
    prCount: link?.prs?.length ?? 0,
    group: link?.agents.some((agent) => agent.status === 'blocked_permission') ? 'needs-you' : STAGE[stage].group,
    blockers: ticket.blockers.map((blocker): ResolvedBlocker => {
      const found = named(blocker);
      return found
        ? { label: found.id, ticket: found, stage: stageOf.get(found.id) }
        : { label: blocker.id ?? blocker.title ?? '?' };
    }),
  }));
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
 * The milestone's target date against today, in whole calendar days.
 *
 * Days rather than a duration: a target is a date on a calendar, so tomorrow at
 * 9am is `due in 1d` whatever the hour now. A datetime target keeps its date.
 */
export function dueLabel(targetDate: string, now = Date.now()): { text: string; late: boolean } {
  const [y = 0, m = 1, d = 1] = targetDate.slice(0, 10).split('-').map(Number);
  const today = new Date(now);
  const days = Math.round(
    (new Date(y, m - 1, d).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (days > 0) return { text: `due in ${days}d`, late: false };
  if (days === 0) return { text: 'due today', late: false };
  return { text: `${-days}d late`, late: true };
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

/** The key of the group holding every item no milestone holds. */
export const OTHER_GROUP = 'other';

/** One group of the fleet list: a plan, or Other. */
export interface FleetGroup<T> {
  /** The milestone id, or `OTHER_GROUP`. */
  key: string;
  /** Absent for Other. */
  plan?: Plan;
  /** Every item of the group, in list order. */
  items: T[];
  /** What is drawn under the row: all of them open, only the live ones collapsed. */
  shown: T[];
}

/**
 * The fleet list as groups: each plan by milestone name, then Other.
 *
 * Alphabetical rather than where a plan's first task stood. The list used to
 * keep that slot, so a plan moved whenever its first task did; named groups in
 * a fixed order are the thing a hand can find without looking. Other comes last
 * and holds everything else in the order it was given — the caller passes
 * running sessions in session order, then parked tasks.
 *
 * Every group folds the same way: open, all of it is drawn; collapsed, only the
 * items with a live agent stay in view, because a group is somewhere to put work
 * away, not somewhere to lose an agent that is running. `expanded` holds the
 * open keys; the caller starts with Other in it. An empty group is not returned.
 *
 * With no plan at all this is one Other group, and the caller draws the list as
 * it was before plans existed.
 */
export function groupFleet<T>(
  items: readonly T[],
  plans: readonly Plan[],
  idOf: (item: T) => string | undefined,
  isLive: (item: T) => boolean,
  expanded: ReadonlySet<string>,
): Array<FleetGroup<T>> {
  const planOf = new Map<string, Plan>();
  for (const plan of plans) for (const ticket of plan.tickets) planOf.set(ticket.id, plan);

  const groups = new Map<string, FleetGroup<T>>();
  for (const item of items) {
    const id = idOf(item);
    const plan = id ? planOf.get(id) : undefined;
    const key = plan?.milestoneId ?? OTHER_GROUP;
    let group = groups.get(key);
    if (!group) {
      group = { key, plan, items: [], shown: [] };
      groups.set(key, group);
    }
    group.items.push(item);
    if (expanded.has(key) || isLive(item)) group.shown.push(item);
  }
  const byName = [...groups.values()]
    .filter((group) => group.plan)
    .sort((a, b) => (a.plan as Plan).name.localeCompare((b.plan as Plan).name, undefined, { sensitivity: 'base' }));
  const other = groups.get(OTHER_GROUP);
  return other ? [...byName, other] : byName;
}
