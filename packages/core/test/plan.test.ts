import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupFleet,
  OTHER_GROUP,
  groupTickets,
  hasLiveAgent,
  linkTickets,
  planSummary,
  readPlan,
  ticketIdOf,
  ticketStatus,
} from '../src/plan.ts';
import type { Plan, Ticket, TicketLink } from '../src/plan.ts';
import type { TaskPr } from '../src/taskPrs.ts';

function ticket(id: string, over: Partial<Ticket> = {}): Ticket {
  return {
    pageId: `page${id}`,
    id,
    url: `https://www.notion.so/${id}`,
    title: `ticket ${id}`,
    notionStatus: 'Todo',
    assignees: [],
    hasPr: false,
    blockers: [],
    body: '',
    ...over,
  };
}

/** A task with one repo on the ticket's branch, and whatever pull requests it has. */
function link(slug: string, prs: Array<Partial<TaskPr>> = [], over: Partial<TicketLink> = {}): TicketLink {
  return {
    task: {
      slug,
      repos: [{ name: 'reflow', path: `/tasks/${slug}/reflow`, branch: `feature/${slug}`, dirty: 0 }],
    },
    prs: prs.map(
      (pr, i) =>
        ({
          repo: 'bigbluedisco/reflow',
          number: 100 + i,
          title: slug,
          url: `https://github.com/bigbluedisco/reflow/pull/${100 + i}`,
          updatedAt: '',
          isDraft: false,
          roles: ['mine'],
          branch: `feature/${slug}`,
          via: 'head',
          repoName: 'reflow',
          ...pr,
        }) as TaskPr,
    ),
    agents: [],
    ...over,
  };
}

test('a task is linked to a ticket by the DEV id in its slug or branch, whatever its case', () => {
  assert.equal(ticketIdOf('stock-dev-1735-transfer-form'), 'DEV-1735');
  assert.equal(ticketIdOf('feature/DEV-1721-orders-accept-the-transfer-order-type'), 'DEV-1721');
  assert.equal(ticketIdOf('feature/flow-execution-labels'), undefined);
  assert.equal(ticketIdOf('fix/kdev-2-tooling'), undefined);
});

test("a ticket with a task reads Fleetwood's status, and drifts when Notion's column disagrees", () => {
  // Merged on GitHub, still `In Review` on the board: the board is behind.
  assert.deepEqual(ticketStatus(ticket('DEV-1', { notionStatus: 'In Review' }), link('dev-1-a', [{ state: 'MERGED' }])), {
    status: 'done',
    drift: true,
  });
  assert.deepEqual(ticketStatus(ticket('DEV-2', { notionStatus: 'Todo' }), link('dev-2-a')), {
    status: 'not-started',
    drift: false,
  });
});

test("a ticket nobody here works reads Notion's column, and cannot drift from it", () => {
  assert.deepEqual(ticketStatus(ticket('DEV-3', { notionStatus: 'In Progress' })), { status: 'wip', drift: false });
  assert.deepEqual(ticketStatus(ticket('DEV-4', { notionStatus: 'In Review', hasPr: true })), {
    status: 'in-review',
    drift: false,
  });
  // Canceled is the end of the line, like Done: nothing waits on it any more.
  assert.deepEqual(ticketStatus(ticket('DEV-5', { notionStatus: 'Canceled' })), { status: 'done', drift: false });
});

function plan(...tickets: Ticket[]): Plan {
  return { milestoneId: 'm1', name: 'Stock Transfers', url: 'https://www.notion.so/m1', tickets };
}

/** Each ticket's group, by id — the shape every blocking question is asked in. */
function groups(read: ReturnType<typeof readPlan>): Record<string, string> {
  return Object.fromEntries(read.map((row) => [row.ticket.id, row.group]));
}

test('a ticket not started is startable once every blocker merged, stackable once each has a PR', () => {
  const read = readPlan(
    plan(
      ticket('DEV-1', { notionStatus: 'Done' }),
      ticket('DEV-2', { notionStatus: 'In Review', hasPr: true }),
      ticket('DEV-10', { blockers: [{ id: 'DEV-1' }] }),
      ticket('DEV-11', { blockers: [{ id: 'DEV-1' }, { id: 'DEV-2' }] }),
      // Named by mention, the way `/to-tickets` writes it.
      ticket('DEV-12', { blockers: [{ pageId: 'pageDEV-3', title: 'ticket DEV-3' }] }),
      ticket('DEV-3', { notionStatus: 'In Progress' }),
      ticket('DEV-13'),
    ),
    new Map(),
  );
  assert.deepEqual(groups(read), {
    'DEV-1': 'done',
    'DEV-2': 'in-review',
    'DEV-10': 'startable',
    'DEV-11': 'stackable',
    'DEV-12': 'blocked',
    'DEV-3': 'in-progress',
    // No `Blocked by` line at all reads as startable — accepted in the spec.
    'DEV-13': 'startable',
  });
});

test('a blocker outside the milestone is unknown, and keeps its ticket blocked', () => {
  const [row] = readPlan(
    plan(ticket('DEV-20', { blockers: [{ id: 'DEV-999' }, { pageId: 'elsewhere', title: 'another spec' }] })),
    new Map(),
  );
  assert.equal(row?.group, 'blocked');
  assert.deepEqual(
    row?.blockers.map((blocker) => [blocker.label, blocker.ticket]),
    [
      ['DEV-999', undefined],
      ['another spec', undefined],
    ],
  );
});

test("a blocker's pull request counts whether Notion or Fleetwood holds it", () => {
  const read = readPlan(
    plan(
      ticket('DEV-30', { notionStatus: 'In Progress' }),
      ticket('DEV-31', { blockers: [{ id: 'DEV-30' }] }),
      // Nobody here works DEV-32; only Notion's relation knows its pull request.
      ticket('DEV-32', { notionStatus: 'In Progress', hasPr: true }),
      ticket('DEV-33', { blockers: [{ id: 'DEV-32' }] }),
    ),
    new Map([['DEV-30', link('dev-30-a', [{ isDraft: true }])]]),
  );
  assert.equal(groups(read)['DEV-31'], 'stackable');
  assert.equal(groups(read)['DEV-33'], 'stackable');
});

test('a ticket needs you when its agent is stopped on you, or its PR has changes requested or failing checks', () => {
  const read = readPlan(
    plan(
      ticket('DEV-40', { notionStatus: 'In Progress' }),
      ticket('DEV-41', { notionStatus: 'In Review' }),
      ticket('DEV-42', { notionStatus: 'In Review' }),
      ticket('DEV-43', { notionStatus: 'In Progress' }),
      ticket('DEV-44', { notionStatus: 'Done' }),
    ),
    new Map([
      ['DEV-40', link('dev-40-a', [], { agents: [{ status: 'blocked_permission' }] })],
      ['DEV-41', link('dev-41-a', [{ reviewDecision: 'CHANGES_REQUESTED' }])],
      ['DEV-42', link('dev-42-a', [{ checks: 'failing' }])],
      // Working, or idle at its prompt: busy, not waiting on you.
      ['DEV-43', link('dev-43-a', [{ isDraft: true }], { agents: [{ status: 'working' }, { status: 'idle' }] })],
      // A merged pull request's last check run is history.
      ['DEV-44', link('dev-44-a', [{ state: 'MERGED', checks: 'failing' }])],
    ]),
  );
  assert.deepEqual(groups(read), {
    'DEV-40': 'needs-you',
    'DEV-41': 'needs-you',
    'DEV-42': 'needs-you',
    'DEV-43': 'in-progress',
    'DEV-44': 'done',
  });
});

const ME = { id: 'u-kilian', name: 'Kilian' };
const ORIANE = { id: 'u-oriane', name: 'Oriane' };

test('the drawer groups tickets in the order that answers what to pick up next, mine first in each', () => {
  const read = readPlan(
    plan(
      ticket('DEV-50', { notionStatus: 'Done' }),
      ticket('DEV-51', { blockers: [{ id: 'DEV-999' }] }),
      ticket('DEV-52', { notionStatus: 'In Review' }),
      ticket('DEV-53', { notionStatus: 'In Progress' }),
      ticket('DEV-54', { blockers: [{ id: 'DEV-52' }], assignees: [ORIANE] }),
      ticket('DEV-55', { assignees: [ORIANE] }),
      // Mine without a task yet: assigned to whoever my linked tickets are assigned to.
      ticket('DEV-56', { assignees: [ME] }),
      ticket('DEV-57', { notionStatus: 'In Progress', assignees: [ME] }),
      ticket('DEV-58', { notionStatus: 'In Progress' }),
    ),
    new Map([
      ['DEV-57', link('dev-57-a', [], { agents: [{ status: 'blocked_permission' }] })],
      ['DEV-52', link('dev-52-a', [{}])],
    ]),
  );
  assert.deepEqual(
    groupTickets(read).map(({ group, tickets }) => [group, tickets.map((row) => row.ticket.id)]),
    [
      ['needs-you', ['DEV-57']],
      ['startable', ['DEV-56', 'DEV-55']],
      ['stackable', ['DEV-54']],
      ['in-progress', ['DEV-53', 'DEV-58']],
      ['in-review', ['DEV-52']],
      ['blocked', ['DEV-51']],
      ['done', ['DEV-50']],
    ],
  );
});

test('the plan row says how far the milestone is, what can start and what needs you', () => {
  const read = readPlan(
    plan(
      ticket('DEV-60', { notionStatus: 'Done' }),
      ticket('DEV-61', { notionStatus: 'Done' }),
      ticket('DEV-62'),
      ticket('DEV-63', { notionStatus: 'In Review' }),
    ),
    new Map([['DEV-63', link('dev-63-a', [{ checks: 'failing' }])]]),
  );
  assert.equal(planSummary(plan(), read), 'Stock Transfers · 2/4 merged · 1 startable · 1 needs you');
  // Nothing to start and nothing on you is not worth a word each.
  assert.equal(planSummary(plan(), read.slice(0, 2)), 'Stock Transfers · 2/2 merged');
});

test('a task is linked by the id in its slug, else its branch, and brings its PRs and agents', () => {
  const tasks = [
    { slug: 'stock-dev-1735-form', branch: 'feature/stock-dev-1735-form', repos: [], session: 'stock' },
    { slug: 'transfer-labels', branch: 'feature/DEV-1736-transfer-labels', repos: [] },
    { slug: 'flow-execution-labels', branch: 'fix/flow-execution-labels', repos: [] },
  ];
  const prs = { 'stock-dev-1735-form': [] };
  const agents = { stock: [{ status: 'working' as const }] };
  const links = linkTickets(tasks, prs, agents);
  assert.deepEqual([...links.keys()], ['DEV-1735', 'DEV-1736']);
  assert.deepEqual(links.get('DEV-1735'), { task: tasks[0], prs: [], agents: [{ status: 'working' }] });
  assert.deepEqual(links.get('DEV-1736'), { task: tasks[1], prs: undefined, agents: [] });
});

test('only an agent doing something, or waiting on you, keeps its task out of a collapsed plan', () => {
  assert.equal(hasLiveAgent([{ status: 'working' }]), true);
  assert.equal(hasLiveAgent([{ status: 'blocked_permission' }]), true);
  assert.equal(hasLiveAgent([{ status: 'idle' }, { status: 'gone' }]), false);
  assert.equal(hasLiveAgent([]), false);
});

/** Two milestones, named so their alphabetical order is not the list's. */
const transfers = { ...plan(ticket('DEV-1'), ticket('DEV-2')), milestoneId: 'm-st', name: 'Stock Transfers' };
const billing = { ...plan(ticket('DEV-3')), milestoneId: 'm-b', name: 'billing' };

/** Each group as `[key, items, shown]`, the shape every grouping question is asked in. */
function grouped(items: string[], expanded: Set<string>, live: (item: string) => boolean = (item) => item === 'dev-2-api') {
  return groupFleet(items, [transfers, billing], ticketIdOf, live, expanded).map((group) => [
    group.key,
    group.items,
    group.shown,
  ]);
}

test('plans come first by milestone name, then Other with every item no milestone holds', () => {
  const items = ['home', 'dev-1-form', 'flow', 'dev-3-invoice', 'dev-2-api', 'parked-task'];
  assert.deepEqual(grouped(items, new Set([OTHER_GROUP])), [
    // Alphabetical whatever the case, not where their first task stood.
    ['m-b', ['dev-3-invoice'], []],
    ['m-st', ['dev-1-form', 'dev-2-api'], ['dev-2-api']],
    // In the order given — running sessions first, then parked tasks, is the caller's list.
    [OTHER_GROUP, ['home', 'flow', 'parked-task'], ['home', 'flow', 'parked-task']],
  ]);
});

test('a collapsed group, plan or Other, keeps only the items with a live agent in view', () => {
  const items = ['home', 'dev-1-form', 'dev-2-api', 'flow'];
  const live = (item: string) => item === 'dev-2-api' || item === 'flow';
  assert.deepEqual(grouped(items, new Set(), live), [
    ['m-st', ['dev-1-form', 'dev-2-api'], ['dev-2-api']],
    [OTHER_GROUP, ['home', 'flow'], ['flow']],
  ]);
  assert.deepEqual(grouped(items, new Set(['m-st']), live)[0], ['m-st', ['dev-1-form', 'dev-2-api'], ['dev-1-form', 'dev-2-api']]);
});

test('with no plan in the fleet there is only Other, and an empty group is never drawn', () => {
  assert.deepEqual(grouped(['home', 'dev-9-x'], new Set([OTHER_GROUP])), [[OTHER_GROUP, ['home', 'dev-9-x'], ['home', 'dev-9-x']]]);
  assert.deepEqual(grouped(['dev-1-form'], new Set()), [['m-st', ['dev-1-form'], []]]);
});

test('no drift is claimed while the first pull request search is still out', () => {
  const searching = { ...link('dev-6-a'), prs: undefined };
  // Committed work and no PR answer yet reads `wip`; the board's `In Review` may well be right.
  searching.task.repos = [{ name: 'reflow', path: '/tasks/dev-6-a/reflow', branch: 'feature/dev-6-a', dirty: 0, ahead: 2 }];
  assert.deepEqual(ticketStatus(ticket('DEV-6', { notionStatus: 'In Review' }), searching), { status: 'wip', drift: false });
});

test('a canceled ticket is neither merged nor counted against the milestone, though it unblocks', () => {
  const read = readPlan(
    plan(
      ticket('DEV-70', { notionStatus: 'Done' }),
      ticket('DEV-71', { notionStatus: 'Canceled' }),
      ticket('DEV-72', { blockers: [{ id: 'DEV-71' }] }),
    ),
    new Map(),
  );
  assert.equal(planSummary(plan(), read), 'Stock Transfers · 1/2 merged · 1 startable');
});
