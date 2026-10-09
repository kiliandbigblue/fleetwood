import { run } from './exec.ts';
import { mapLimit } from './github.ts';
import { extractToken } from './limits.ts';
import { ticketIdsIn } from './plan.ts';
import type { Blocker, Plan, Ticket } from './plan.ts';

/*
 * The milestone a ticket belongs to, and every ticket in it, read from Notion.
 *
 * Read-only toward Notion, and only ever will be: a status written back from here
 * would be a second writer on a board the whole team moves by hand. Off until
 * `notion.tokenCommand` is set, for the reason the quota gauges are — reading it
 * means handing fleetwood a credential, and the operator says where it comes from.
 *
 * The HTTP below is kept thin on purpose. Every decision about what the payload
 * means is a pure function in this file or in `plan.ts`, tested against the shape
 * the API returns; the requests themselves are not unit-tested.
 */

/** One rich-text run, as far as anything here reads it. */
interface RichText {
  type?: string;
  plain_text?: string;
  mention?: { type?: string; page?: { id?: string } };
}

/**
 * A block's text runs, whatever kind of block it is.
 *
 * Every text-bearing block keeps them under its own type's key —
 * `paragraph.rich_text`, `to_do.rich_text`, `bulleted_list_item.rich_text` — so
 * the type is the key. Anything not shaped like that has no text, which is what
 * lets an unreadable block fall out rather than throw.
 */
function richTextOf(block: unknown): RichText[] {
  if (block === null || typeof block !== 'object') return [];
  const type = (block as { type?: unknown }).type;
  if (typeof type !== 'string') return [];
  const body = (block as Record<string, unknown>)[type] as { rich_text?: unknown } | undefined;
  return Array.isArray(body?.rich_text) ? (body.rich_text as RichText[]) : [];
}

const plain = (runs: RichText[]): string => runs.map((run) => run.plain_text ?? '').join('');

const BLOCKED_BY = /^\W*blocked by\s*:/i;

/**
 * The tickets a ticket waits on, off the `**Blocked by:**` line of its body.
 *
 * "None", a body with no such line and a line that cannot be read all come back
 * empty — no blockers. That is deliberate rather than cautious: a ticket written
 * by hand without the line reads as startable, which the spec accepts because
 * `/to-tickets` always writes it. The alternative, reading a missing line as
 * "unknown", would park every hand-written ticket in `blocked` for good.
 *
 * Only the first such line counts; the line is one sentence, not a section.
 * Prose on it — "and Yasmina's list of orders" — is not a ticket and is dropped:
 * nothing here can tell when a human has delivered a list.
 */
export function blockersOf(blocks: unknown): Blocker[] {
  if (!Array.isArray(blocks)) return [];
  const runs = blocks.map(richTextOf).find((line) => BLOCKED_BY.test(plain(line)));
  if (!runs) return [];

  const out: Blocker[] = [];
  const seen = new Set<string>();
  const add = (key: string, blocker: Blocker): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(blocker);
  };
  for (const run of runs) {
    const pageId = run.type === 'mention' && run.mention?.type === 'page' ? run.mention.page?.id : undefined;
    if (pageId) {
      const id = pageId.replace(/-/g, '');
      add(id, { pageId: id, title: run.plain_text ?? '' });
      continue;
    }
    for (const id of ticketIdsIn(run.plain_text ?? '')) add(id, { id });
  }
  return out;
}

/**
 * A page body as the text a person would copy out of it.
 *
 * It becomes the goal of a task started from the ticket, so the shape a reader
 * relies on is kept — a checklist still reads as one — and nothing else: no
 * bold, no colours, a mention as the title it shows. Child blocks are not read;
 * a ticket's body is one level deep, and fetching every toggle's children would
 * be a request per nested block for text nobody asked to see.
 */
export function bodyText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const lines: string[] = [];
  for (const block of blocks) {
    const text = plain(richTextOf(block));
    const type = (block as { type?: unknown } | null)?.type;
    if (type === 'to_do') {
      const checked = (block as { to_do?: { checked?: boolean } }).to_do?.checked === true;
      lines.push(`- [${checked ? 'x' : ' '}] ${text}`);
    } else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
    else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
    else if (typeof type === 'string' && /^heading_[123]$/.test(type)) {
      lines.push(`${'#'.repeat(Number(type.slice(-1)))} ${text}`);
    } else if (type === 'code') lines.push('```', text, '```');
    else if (text.length > 0 || type === 'paragraph') lines.push(text);
  }
  return lines.join('\n').trim();
}

/** A property of a page, typed loosely — the payload is not ours to trust. */
type Property = Record<string, unknown> & { type?: string };

function propertiesOf(page: unknown): Record<string, Property> {
  if (page === null || typeof page !== 'object') return {};
  const properties = (page as { properties?: unknown }).properties;
  return properties !== null && typeof properties === 'object' ? (properties as Record<string, Property>) : {};
}

/** The ids a relation property holds, without dashes. */
export function relationIds(page: unknown, name: string): string[] {
  const relation = propertiesOf(page)[name]?.relation;
  if (!Array.isArray(relation)) return [];
  return relation
    .map((entry) => (entry as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.replace(/-/g, ''));
}

/**
 * A milestone's `Progress` and `Target date`.
 *
 * The API hands a formula back as its result, not its expression, so `Progress`
 * is already the 0–100 the board shows. Either is left out when the page does
 * not carry it in that shape.
 */
export function milestoneFacts(page: unknown): { progress?: number; targetDate?: string } {
  const properties = propertiesOf(page);
  const progress = (properties.Progress?.formula as { number?: unknown } | undefined)?.number;
  const target = (properties['Target date']?.date as { start?: unknown } | undefined)?.start;
  return {
    ...(typeof progress === 'number' && Number.isFinite(progress)
      ? { progress: Math.min(100, Math.max(0, progress)) }
      : {}),
    ...(typeof target === 'string' ? { targetDate: target.slice(0, 10) } : {}),
  };
}

/** A page's title, whichever property holds it — milestones name theirs differently. */
export function titleOf(page: unknown): string {
  for (const property of Object.values(propertiesOf(page))) {
    if (property.type === 'title' && Array.isArray(property.title)) return plain(property.title as RichText[]);
  }
  return '';
}

/**
 * One ticket off its page and its body.
 *
 * `undefined` for a page with no `DEV` id: the id is the only thing a task can
 * be linked by, so a page without one has nothing to join and no row to draw.
 */
export function parseTicket(page: unknown, blocks: unknown): Ticket | undefined {
  if (page === null || typeof page !== 'object') return undefined;
  const properties = propertiesOf(page);
  const unique = properties.ID?.unique_id as { prefix?: unknown; number?: unknown } | undefined;
  if (typeof unique?.number !== 'number') return undefined;
  const prefix = typeof unique.prefix === 'string' && unique.prefix.length > 0 ? unique.prefix : 'DEV';

  const people = properties.Assignee?.people;
  const status = properties.Status?.status as { name?: unknown } | undefined;
  const pageId = String((page as { id?: unknown }).id ?? '').replace(/-/g, '');
  return {
    pageId,
    id: `${prefix.toUpperCase()}-${unique.number}`,
    url: String((page as { url?: unknown }).url ?? `https://www.notion.so/${pageId}`),
    title: titleOf(page),
    notionStatus: typeof status?.name === 'string' ? status.name : '',
    assignees: (Array.isArray(people) ? people : [])
      .map((person) => person as { id?: unknown; name?: unknown })
      .filter((person) => typeof person.id === 'string')
      .map((person) => ({ id: person.id as string, name: typeof person.name === 'string' ? person.name : '' })),
    hasPr: relationIds(page, 'GitHub Pull Requests').length > 0,
    blockers: blockersOf(blocks),
    body: bodyText(blocks),
  };
}

const API = 'https://api.notion.com/v1';
/**
 * Pinned, as the API requires. 2022-06-28 still queries a database by its own id;
 * the newer versions want the id of its data source instead, which is one more
 * id to find for a database that has only ever had one.
 */
const NOTION_VERSION = '2022-06-28';
/** The Tasks Database — the one every ticket lives in. */
const TASKS_DATABASE = 'ca4e7f141b8e4eb8989bba3aaae58b7f';
/**
 * How many requests are out at once — a cap on parallelism, not a rate. Notion
 * averages about three a second per integration; a 429 past that is waited out
 * in `call`, not avoided here.
 */
const CONCURRENCY = 3;
/** Retries after a 429. Two, then the fetch fails and the last plans go stale. */
const RATE_LIMIT_RETRIES = 2;
const TIMEOUT_MS = 10_000;

/**
 * How long a 429 asks to be left alone, in milliseconds.
 *
 * `Retry-After` is in seconds; a header that is missing or unreadable waits one,
 * which is about what Notion's three-a-second average needs to recover.
 */
export function retryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  return retryAfter !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 1_000;
}

/**
 * Whether a ticket's body is worth a request.
 *
 * Only for a ticket that can still be started or is in flight: a done or
 * canceled one is never asked what blocks it, and nobody starts a task from it,
 * so its body is a page read per landed ticket on every poll for nothing.
 */
export function wantsBody(page: unknown): boolean {
  const status = propertiesOf(page).Status?.status as { name?: unknown } | undefined;
  const name = typeof status?.name === 'string' ? status.name.trim().toLowerCase() : '';
  return name !== 'done' && name !== 'canceled';
}

async function call(token: string, path: string, body?: unknown, retries = RATE_LIMIT_RETRIES): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // One rate limit must not fail the whole plan on every poll: wait as asked, retry.
  if (response.status === 429 && retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers.get('Retry-After'))));
    return call(token, path, body, retries - 1);
  }
  if (!response.ok) throw new Error(`notion ${path}: ${response.status}`);
  return response.json();
}

/** Every page a database query matches, following the cursor. */
async function queryAll(token: string, body: Record<string, unknown>): Promise<unknown[]> {
  const pages: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = (await call(token, `/databases/${TASKS_DATABASE}/query`, {
      ...body,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
    pages.push(...(page.results ?? []));
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return pages;
}

export interface PlansOptions {
  /** Shell command printing an internal integration token. Unset means no plans. */
  tokenCommand?: string;
  /** The `DEV-NNNN` ids the fleet's tasks are linked to — see `linkTickets`. */
  ticketIds: string[];
}

/**
 * The milestone of every ticket the fleet works, with all of its tickets.
 *
 * A milestone becomes a plan the moment one task is linked to one of its
 * tickets, so the walk starts from the tasks: each id is looked up by the `ID`
 * property, its `Milestone` relation names the plan, and the plan's tickets are
 * one query on that relation — every ticket with its properties, which the
 * milestone's own `Tasks` relation would have given as bare ids, capped at 25.
 * Then one page read per ticket for its body, which is where the blockers are.
 *
 * `undefined` on any failure, never a throw and never a partial answer: the
 * caller keeps the last plans and marks them stale, the way the quota gauges do,
 * and half a milestone would read as tickets having left it.
 */
export async function fetchPlans(options: PlansOptions): Promise<Plan[] | undefined> {
  const command = options.tokenCommand?.trim();
  if (!command) return undefined;
  const printed = await run('/bin/sh', ['-c', command], { timeoutMs: TIMEOUT_MS });
  if (printed.code !== 0) return undefined;
  const token = extractToken(printed.stdout);
  if (!token) return undefined;

  try {
    const ids = [...new Set(options.ticketIds)];
    const found = await mapLimit(ids, CONCURRENCY, (id) =>
      queryAll(token, { filter: { property: 'ID', unique_id: { equals: Number(id.replace(/^\D+-/, '')) } } }),
    );
    const milestones = [...new Set(found.flatMap((pages) => relationIds(pages[0], 'Milestone')))];

    return await mapLimit(milestones, 1, async (milestoneId): Promise<Plan> => {
      const milestone = await call(token, `/pages/${milestoneId}`);
      const pages = await queryAll(token, {
        filter: { property: 'Milestone', relation: { contains: milestoneId } },
        sorts: [{ property: 'ID', direction: 'ascending' }],
      });
      // ponytail: the first 100 blocks of a body only; a ticket longer than that
      // is a spec, and its `Blocked by` line sits at the top anyway.
      const bodies = await mapLimit(pages, CONCURRENCY, (page) =>
        wantsBody(page)
          ? call(token, `/blocks/${String((page as { id?: unknown }).id)}/children?page_size=100`)
          : Promise.resolve(undefined),
      );
      const tickets = pages
        .map((page, i) => parseTicket(page, (bodies[i] as { results?: unknown } | undefined)?.results))
        .filter((ticket): ticket is Ticket => ticket !== undefined);
      return {
        milestoneId,
        name: titleOf(milestone) || 'untitled milestone',
        url: String((milestone as { url?: unknown }).url ?? `https://www.notion.so/${milestoneId}`),
        ...milestoneFacts(milestone),
        tickets,
      };
    });
  } catch {
    return undefined;
  }
}
