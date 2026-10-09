import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockersOf, milestoneFacts, parseTicket, retryDelayMs, wantsBody } from '../src/notion.ts';

/*
 * Blocks shaped the way `GET /v1/blocks/{id}/children` returns them, trimmed to
 * the fields read. The first one is DEV-1779's body as `/to-tickets` wrote it:
 * the blocker is a page mention, whose `plain_text` is the other ticket's title,
 * not its id — so a parser that only looked for `DEV-NNNN` in the text would
 * read this ticket as startable.
 */
const text = (content: string, bold = false) => ({
  type: 'text',
  text: { content },
  plain_text: content,
  annotations: { bold },
});
const mention = (id: string, title: string) => ({
  type: 'mention',
  mention: { type: 'page', page: { id } },
  plain_text: title,
});
const paragraph = (...rich: unknown[]) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich } });
const todo = (content: string, checked = false) => ({
  object: 'block',
  type: 'to_do',
  to_do: { rich_text: [text(content)], checked },
});

const DEV_1779 = [
  paragraph(text('What to build:', true), text(' the B2B orders merchants used as transfers become transfers.')),
  paragraph(
    text('Blocked by:', true),
    text(' '),
    mention('3e93b38f-6a0c-813f-82e9-e95ef84ea88f', 'orders: accept the TRANSFER order type'),
    text(", and Yasmina's list of orders with their destination warehouse"),
  ),
  todo('dry run first, with the orders it would change'),
];

test('a blocker written as a page mention is read by its page, with its title to show', () => {
  assert.deepEqual(blockersOf(DEV_1779), [
    { pageId: '3e93b38f6a0c813f82e9e95ef84ea88f', title: 'orders: accept the TRANSFER order type' },
  ]);
});

test('every DEV id typed on the line is a blocker, whatever its case', () => {
  const blocks = [paragraph(text('Blocked by:', true), text(' DEV-1721, dev-1734 and DEV-1721 again'))];
  assert.deepEqual(blockersOf(blocks), [{ id: 'DEV-1721' }, { id: 'DEV-1734' }]);
});

test('a word that merely ends in dev is not a blocker, the same rule a task link uses', () => {
  const blocks = [paragraph(text('Blocked by:', true), text(' the kdev-2 tooling, then DEV-7'))];
  assert.deepEqual(blockersOf(blocks), [{ id: 'DEV-7' }]);
});

test('"None", a missing line and an unreadable one all mean no blockers', () => {
  assert.deepEqual(blockersOf([paragraph(text('Blocked by:', true), text(' None'))]), []);
  assert.deepEqual(blockersOf([paragraph(text('What to build: a thing'))]), []);
  assert.deepEqual(blockersOf([{ type: 'paragraph' }, null, 'garbage']), []);
  assert.deepEqual(blockersOf(undefined), []);
});

/** DEV-1779's page as `POST /v1/databases/{id}/query` returns it, trimmed. */
const DEV_1779_PAGE = {
  object: 'page',
  id: '3eb3b38f-6a0c-8167-94c8-dc323d5c5221',
  url: 'https://www.notion.so/Script-3eb3b38f6a0c816794c8dc323d5c5221',
  properties: {
    ID: { type: 'unique_id', unique_id: { prefix: 'DEV', number: 1779 } },
    'Task Name': { type: 'title', title: [{ plain_text: "Script: set Yasmina's past fake-transfer orders to TRANSFER" }] },
    Status: { type: 'status', status: { name: 'Todo' } },
    Assignee: { type: 'people', people: [{ object: 'user', id: '437959c2-3d53-47dc-bc04-0dee766f152c', name: 'Kilian' }] },
    'GitHub Pull Requests': { type: 'relation', relation: [], has_more: false },
    Milestone: { type: 'relation', relation: [{ id: '3eb3b38f-6a0c-8181-9d95-d30352305722' }] },
  },
};

test('a ticket page reads as its id, title, Notion status, assignee, PRs, blockers and body', () => {
  assert.deepEqual(parseTicket(DEV_1779_PAGE, DEV_1779), {
    pageId: '3eb3b38f6a0c816794c8dc323d5c5221',
    id: 'DEV-1779',
    url: 'https://www.notion.so/Script-3eb3b38f6a0c816794c8dc323d5c5221',
    title: "Script: set Yasmina's past fake-transfer orders to TRANSFER",
    notionStatus: 'Todo',
    assignees: [{ id: '437959c2-3d53-47dc-bc04-0dee766f152c', name: 'Kilian' }],
    hasPr: false,
    blockers: [{ pageId: '3e93b38f6a0c813f82e9e95ef84ea88f', title: 'orders: accept the TRANSFER order type' }],
    body: [
      'What to build: the B2B orders merchants used as transfers become transfers.',
      "Blocked by: orders: accept the TRANSFER order type, and Yasmina's list of orders with their destination warehouse",
      '- [ ] dry run first, with the orders it would change',
    ].join('\n'),
  });
});

test('a page with no DEV id is not a ticket fleetwood can link anything to', () => {
  const { ID: _drop, ...properties } = DEV_1779_PAGE.properties;
  assert.equal(parseTicket({ ...DEV_1779_PAGE, properties }, []), undefined);
  assert.equal(parseTicket(null, []), undefined);
});

test("a rate limit waits as long as Notion asks, a second when it doesn't say", () => {
  assert.equal(retryDelayMs('2'), 2_000);
  assert.equal(retryDelayMs('0.5'), 500);
  assert.equal(retryDelayMs(null), 1_000);
  assert.equal(retryDelayMs('soon'), 1_000);
});

test("a done or canceled ticket's body is not read: its blockers and goal are never used", () => {
  const withStatus = (name: string) => ({
    ...DEV_1779_PAGE,
    properties: { ...DEV_1779_PAGE.properties, Status: { type: 'status', status: { name } } },
  });
  assert.equal(wantsBody(withStatus('Todo')), true);
  assert.equal(wantsBody(withStatus('In Review')), true);
  assert.equal(wantsBody(withStatus('Done')), false);
  assert.equal(wantsBody(withStatus('Canceled')), false);
});

test("a milestone's Progress is the formula's result, clamped, and its target date the day it starts", () => {
  const page = (progress: unknown, start?: string) => ({
    properties: {
      Progress: { type: 'formula', formula: { type: 'number', number: progress } },
      'Target date': { type: 'date', date: start ? { start, end: null } : null },
    },
  });
  assert.deepEqual(milestoneFacts(page(62.5, '2026-10-14')), { progress: 62.5, targetDate: '2026-10-14' });
  assert.deepEqual(milestoneFacts(page(140, '2026-10-14T09:00:00.000+02:00')), { progress: 100, targetDate: '2026-10-14' });
  // A formula that errors or goes empty comes back null; no number, no bar.
  assert.deepEqual(milestoneFacts(page(null)), {});
});
