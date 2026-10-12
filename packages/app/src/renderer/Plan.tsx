import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Plan, PlanTicket, Ticket, TicketGroup } from '@fleetwood/core';
// The leaf modules: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { dueLabel, landed, splitPlan, STAGE } from '@fleetwood/core/plan';
import { STATUS_LABEL } from '@fleetwood/core/taskStatus';
import { Icon } from './Icon.tsx';
import { duration, send } from './api.ts';
import { useNow } from './useNow.ts';

/**
 * A plan in the fleet list: one line for a whole milestone, its tasks under it.
 *
 * The head opens the plan's drawer, the way a task card's opens its pane — a
 * plan has no session for the head to focus, so the one thing it can mean is
 * "show me the plan". The tasks start folded: six stock transfer cards between
 * unrelated work were the flood this replaces.
 *
 * The caption is the milestone's progress and its date, and nothing else. What
 * needs you is said by the task cards under it — an agent stopped on a prompt
 * is live, so its card is drawn here even folded — and in the drawer, which
 * sorts it first. Saying it on this row too was saying it twice.
 */
export function PlanRow({
  plan,
  expanded,
  folded,
  onToggle,
  onOpen,
  children,
}: {
  plan: Plan;
  expanded: boolean;
  /** How many of the plan's tasks are out of view right now. */
  folded: number;
  onToggle: () => void;
  onOpen: () => void;
  /** The plan's tasks that are drawn under it. */
  children?: ReactNode;
}): React.JSX.Element {
  const now = useNow(60_000);
  const caption = planCaption(plan, now);
  return (
    <GroupRow
      title={plan.name}
      kind="plan"
      summary={caption.drawn}
      spoken={caption.spoken}
      onHead={onOpen}
      headHint="open the plan — every ticket, and where each one has got to"
      control={<Fold expanded={expanded} folded={folded} onToggle={onToggle} />}
    >
      {children}
    </GroupRow>
  );
}

/**
 * A plan's caption: its progress as a bar and a number, then anything the
 * caller adds, then its date. Shared by the rail row and the drawer's head, so
 * the two say the same thing in the same place.
 */
interface CaptionFact {
  text: string;
  className?: string;
  title?: string;
}

function planCaption(
  plan: Plan,
  nowMs: number,
  extra: CaptionFact[] = [],
): { drawn: React.JSX.Element; spoken: string } {
  const percent = plan.progress !== undefined ? `${Math.round(plan.progress)}%` : undefined;
  const due = plan.targetDate ? dueLabel(plan.targetDate, nowMs) : undefined;
  return {
    drawn: (
      <span className="plan-caption">
        {plan.progress !== undefined && <Meter value={plan.progress} />}
        {percent && <span>{percent}</span>}
        {extra.map((fact) => (
          <span key={fact.text} className={fact.className} title={fact.title}>
            {fact.text}
          </span>
        ))}
        {due && <span className={due.late ? 'plan-alarm' : undefined}>{due.text}</span>}
      </span>
    ),
    spoken: [percent, ...extra.map((fact) => fact.text), due?.text].filter(Boolean).join(', '),
  };
}

/**
 * A group of the fleet list — a plan, or Other — and the items drawn under it;
 * and, as the drawer's head, the plan opened.
 *
 * One row, so a group looks the same wherever it is drawn. The caller says what
 * the head does — open a plan's drawer, or for Other fold its items, since it
 * has nothing behind it — and what sits on its trailing edge: the fold on the
 * fleet, `refresh` in the drawer.
 */
export function GroupRow({
  title,
  kind = 'group',
  summary,
  spoken,
  onHead,
  headHint,
  control,
  children,
}: {
  title: string;
  /** What a screen reader hears the row is. */
  kind?: string;
  /** The caption on the head's right edge. */
  summary: ReactNode;
  /** The caption in words, for a screen reader. */
  spoken: string;
  onHead: () => void;
  /** What a click on the head does, in words. */
  headHint: string;
  /** The trailing control. Its clicks are its own, never the head's too. */
  control: ReactNode;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <div className="card group-card">
        <div className="card-head" onClick={onHead} title={headHint}>
          {/* The keyboard's way in, as on a task card: Enter presses it and the
              press bubbles to the head. */}
          <button type="button" className="card-title group-title">
            {title}
            <span className="sr-only">
              , {kind}
              {spoken && `, ${spoken}`}
            </span>
          </button>
          <span className="repo-summary">{summary}</span>
          <span className="group-control" onClick={(event) => event.stopPropagation()}>
            {control}
          </span>
        </div>
      </div>
      {children && <div className="plan-tasks">{children}</div>}
    </>
  );
}

/** A group's fold: what is under it, shown or put away. */
export function Fold({
  expanded,
  folded,
  onToggle,
}: {
  expanded: boolean;
  /** How many of the group's items are out of view right now. */
  folded: number;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`card-fold${expanded ? ' open' : ''}`}
      aria-expanded={expanded}
      title={expanded ? 'fold it away' : `show what is under it${folded > 0 ? ` — ${folded} folded` : ''}`}
      onClick={onToggle}
    >
      <Icon name="chevron" />
    </button>
  );
}

/**
 * The milestone's progress as a bar. Hidden from a screen reader: the number
 * beside it says the same, and is what gets read.
 */
function Meter({ value }: { value: number }): React.JSX.Element {
  return (
    <span className={`plan-meter${value >= 100 ? ' full' : ''}`} aria-hidden="true">
      <span style={{ width: `${value}%` }} />
    </span>
  );
}

/**
 * A section's heading in the drawer.
 *
 * `stackable` spells out what it means, because it is the one state here that is
 * not a board column: the work can start, cut from a blocker's branch that is
 * still in review. `merged` says why it is still up here rather than folded.
 */
const GROUP_LABEL: Record<TicketGroup, string> = {
  'needs-you': 'needs you',
  startable: 'startable',
  stackable: 'stackable — on a PR still open',
  'in-progress': 'in progress',
  'in-review': 'in review',
  merged: 'merged — not live yet',
  blocked: 'blocked',
  done: 'deployed',
};

/**
 * The plan opened: the milestone's tasks as the fleet draws them, what is yours
 * to start as the task it would become, then everyone else's tickets.
 *
 * A task and a ticket are kept two different things: a ticket a task here works
 * is that task's own card, the same one the fleet draws, never a second
 * rendering of it. A ticket of yours with no task yet is drawn as the parked
 * task it turns into, and its head starts it. A teammate's is a plain ticket row.
 *
 * Read-only toward Notion. Every link out goes to the card, and nothing here
 * moves one: the board is the team's.
 */
export function PlanView({
  plan,
  rows,
  me,
  fetchedAt,
  stale,
  refreshing,
  taskOrder,
  renderTask,
  onRefresh,
  onStart,
  onResult,
}: {
  plan: Plan;
  rows: PlanTicket[];
  /** The Notion user the plans were read as — see `isMine`. */
  me?: string;
  /** Epoch seconds the plans were read at. */
  fetchedAt: number;
  /** The last read failed, and this is the one before it. */
  stale?: boolean;
  refreshing: boolean;
  /** Task slugs in fleet order, so the cards here stand as they do there. */
  taskOrder: readonly string[];
  /** The fleet's own card for a task. */
  renderTask: (slug: string) => ReactNode;
  onRefresh: () => void;
  onStart: (ticket: Ticket) => void;
  onResult: (message: string, ok: boolean) => void;
}): React.JSX.Element {
  const nowMs = useNow(30_000);
  const now = Math.floor(nowMs / 1000);
  // Shipped work is the bulk of a milestone by its end, and asks nothing.
  const [showDone, setShowDone] = useState(false);
  const open = (url: string): void => {
    void send({ kind: 'openExternal', url }).then((result) => onResult(result.detail, result.ok));
  };
  // Fleetwood's own count beside Notion's estimate-weighted percentage: the two
  // answer different questions, and this one knows about deploys.
  const counted = rows.filter((row) => row.stage !== 'canceled');
  const deployed = counted.filter((row) => row.stage === 'deployed').length;
  const caption = planCaption(plan, nowMs, [
    { text: `${deployed} of ${counted.length} deployed` },
    // Said, not swallowed: without it your assigned tickets read as a teammate's.
    ...(me === undefined
      ? [{ text: 'Notion did not say who you are', className: 'quota-stale', title: 'only unassigned tickets count as yours' }]
      : []),
    // Dated rather than hidden, like the quota gauges: a stale plan still says
    // roughly where the milestone stands.
    ...(stale
      ? [{ text: `as of ${duration(now - fetchedAt)} ago`, className: 'quota-stale', title: 'Notion did not answer the last read' }]
      : []),
  ]);
  const { tasks, toStart, rest } = splitPlan(rows, me);
  const rank = (row: PlanTicket): number => {
    const at = taskOrder.indexOf(row.link?.task.slug ?? '');
    return at === -1 ? taskOrder.length : at;
  };

  return (
    <div className="plan-view">
      {/* The rail row you opened, so opening a milestone reads as that row
          unfolding rather than as another page. The count of deploys joins its
          caption, and `refresh` takes the place of the fold. */}
      <GroupRow
        title={plan.name}
        kind="milestone"
        summary={caption.drawn}
        spoken={caption.spoken}
        onHead={() => open(plan.url)}
        headHint="open the milestone in Notion"
        control={
          <button className="chip" disabled={refreshing} onClick={onRefresh} title="read the milestone from Notion again">
            {refreshing ? 'reading…' : 'refresh'}
          </button>
        }
      />
      {rows.length === 0 && <div className="empty">no tickets read from this milestone</div>}
      {tasks.length > 0 && (
        <section className="plan-group">
          <div className="section-title" role="heading" aria-level={2}>
            tasks · {tasks.length}
          </div>
          {[...tasks].sort((a, b) => rank(a) - rank(b)).map((row) => row.link && renderTask(row.link.task.slug))}
        </section>
      )}
      {toStart.length > 0 && (
        <section className="plan-group">
          <div className="section-title" role="heading" aria-level={2}>
            to start · {toStart.length}
          </div>
          {toStart.map((row) => (
            <GhostCard key={row.ticket.id} row={row} onOpen={open} onStart={onStart} />
          ))}
        </section>
      )}
      {rest.map(({ group, tickets }) => {
        const folds = group === 'done';
        return (
          <section key={group} className="plan-group">
            <div className="section-title" role="heading" aria-level={2}>
              {folds ? (
                <button
                  className={`plan-fold${showDone ? ' open' : ''}`}
                  aria-expanded={showDone}
                  onClick={() => setShowDone(!showDone)}
                >
                  {GROUP_LABEL[group]} · {tickets.length}
                  <Icon name="chevron" />
                </button>
              ) : (
                `${GROUP_LABEL[group]} · ${tickets.length}`
              )}
            </div>
            {(!folds || showDone) &&
              tickets.map((row) => <TicketRow key={row.ticket.id} row={row} onOpen={open} />)}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The ticket's id, out to its Notion card. The one way to Notion from a card,
 * so the same on a task working the ticket and on one that is still to start.
 */
export function TicketId({ ticket, onOpen }: { ticket: Ticket; onOpen: (url: string) => void }): React.JSX.Element {
  return (
    <button
      className="plan-ticket-id"
      onClick={(event) => {
        // On a card head's line, which focuses or starts the task.
        event.stopPropagation();
        onOpen(ticket.url);
      }}
      title={`open ${ticket.id} in Notion`}
    >
      {ticket.id}
      {'\u00a0'}
      <span aria-hidden="true">↗</span>
    </button>
  );
}

/** A blocker that has not landed, and where it has got to. */
function blockerText(row: PlanTicket): string | undefined {
  // A landed blocker blocks nothing, and naming it beside the live one made the
  // ticket read as more stuck than it is.
  const blockers = row.blockers.filter((blocker) => !blocker.stage || !landed(blocker.stage));
  if (STAGE[row.stage].status !== 'not-started' || blockers.length === 0) return undefined;
  return `blocked by ${blockers
    .map((blocker) => `${blocker.label} (${blocker.stage ? STAGE[blocker.stage].label : 'unknown'})`)
    .join(', ')}`;
}

/**
 * A ticket of yours with no task yet, drawn as the parked task it becomes.
 *
 * A dormant card's shell and its one-line head, so starting it is the card
 * turning into itself: the head opens new task on the ticket, as a parked
 * task's head opens its session. Dimmer than a parked task — nothing exists
 * yet — and named by the ticket's title, since there is no slug to show.
 */
function GhostCard({
  row,
  onOpen,
  onStart,
}: {
  row: PlanTicket;
  onOpen: (url: string) => void;
  onStart: (ticket: Ticket) => void;
}): React.JSX.Element {
  const { ticket } = row;
  const blocked = blockerText(row);
  return (
    <div className="card dormant ghost">
      <div
        className="card-head"
        onClick={() => onStart(ticket)}
        title={
          row.group === 'blocked'
            ? 'no task yet — start one; a blocker has no pull request yet, so stack or stub what it needs'
            : 'no task yet — start one, on a branch that carries the ticket id'
        }
      >
        <span className="task-status-dot task-status-not-started" title="no task yet" />
        {/* The keyboard's way in, as on a task card. */}
        <button type="button" className="session-name card-title">
          {ticket.title}
          <span className="sr-only">, no task yet, {STAGE[row.stage].label}</span>
        </button>
      </div>
      <div className="plan-ticket-meta task-ticket">
        <TicketId ticket={ticket} onOpen={onOpen} />
        <span className="plan-stage" data-stage={row.stage}>
          {STAGE[row.stage].label}
        </span>
        {blocked && <span>{blocked}</span>}
      </div>
    </div>
  );
}

/**
 * A ticket that is not yours to start: a teammate's, or yours already moving
 * with no task here. What it is on the first line, where it has got to and who
 * is on it on the second. Not a card: there is no task here to become.
 */
function TicketRow({ row, onOpen }: { row: PlanTicket; onOpen: (url: string) => void }): React.JSX.Element {
  const { ticket } = row;
  const assignees = ticket.assignees.map((assignee) => assignee.name).join(', ');
  const blocked = blockerText(row);
  return (
    <div className={`plan-ticket${row.group === 'done' ? ' plan-ticket-done' : ''}`}>
      <div className="plan-ticket-line">
        <span
          className={`task-status-dot task-status-${STAGE[row.stage].status}`}
          title={STATUS_LABEL[STAGE[row.stage].status]}
        />
        {/* The row's one keyboard stop, on the list's j/k walk; `owes` puts the
            ones waiting on you on `n`, as on the pull requests tab. */}
        <button
          className={`plan-ticket-id list-stop${row.group === 'needs-you' ? ' owes' : ''}`}
          onClick={() => onOpen(ticket.url)}
          title={`open ${ticket.id} in Notion`}
        >
          {ticket.id}
        </button>
        <span className="plan-ticket-title" title={ticket.title}>
          {ticket.title}
        </span>
      </div>
      {/* The separators are drawn by the stylesheet, so a part that has nothing
          to say simply is not here. */}
      <div className="plan-ticket-meta">
        <span className="plan-stage" data-stage={row.stage}>
          {STAGE[row.stage].label}
          {row.prCount > 1 && ` · ${row.prCount} PRs`}
        </span>
        <span>{assignees || 'unassigned'}</span>
        {blocked && <span>{blocked}</span>}
      </div>
    </div>
  );
}
