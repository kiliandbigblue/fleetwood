import type { ReactNode } from 'react';
import type { Plan, PlanTicket, Ticket, TicketGroup } from '@fleetwood/core';
// The leaf modules: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { groupTickets, planCounts } from '@fleetwood/core/plan';
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
 * No attention band, even with a ticket that needs you. The band is kept for an
 * agent stopped on a prompt, and that agent's task card is live, so it is drawn
 * under this row with its own band — banding the plan too would say one prompt
 * twice. A red check or a change request is said in words, like everywhere else.
 */
export function PlanRow({
  plan,
  rows,
  expanded,
  folded,
  onToggle,
  onOpen,
  children,
}: {
  plan: Plan;
  rows: PlanTicket[];
  expanded: boolean;
  /** How many of the plan's tasks are out of view right now. */
  folded: number;
  onToggle: () => void;
  onOpen: () => void;
  /** The plan's tasks that are drawn under it. */
  children?: ReactNode;
}): React.JSX.Element {
  const { progress, needsYou } = planCounts(rows);
  return (
    <GroupRow
      title={plan.name}
      kind="plan"
      caption={progress}
      needsYou={needsYou}
      expanded={expanded}
      folded={folded}
      onToggle={onToggle}
      onOpen={onOpen}
    >
      {children}
    </GroupRow>
  );
}

/**
 * A group of the fleet list — a plan, or Other — and the items drawn under it.
 *
 * Every group folds the same way, which is why this is one row: collapsed, only
 * what has a live agent stays in view (see `groupFleet`). The head opens the
 * group when it has something to open — a plan's drawer — and otherwise is the
 * fold itself, since Other has nothing behind it but its own items.
 */
export function GroupRow({
  title,
  kind = 'group',
  caption,
  needsYou = 0,
  expanded,
  folded,
  onToggle,
  onOpen,
  children,
}: {
  title: string;
  /** What a screen reader hears the row is. */
  kind?: string;
  caption: string;
  needsYou?: number;
  expanded: boolean;
  /** How many of the group's items are out of view right now. */
  folded: number;
  onToggle: () => void;
  /** Absent for a group with nothing to open: then the head folds. */
  onOpen?: () => void;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <div className="card plan-card">
        <div
          className="card-head"
          onClick={onOpen ?? onToggle}
          title={onOpen ? 'open the plan — every ticket, and what each one waits on' : expanded ? 'fold it away' : 'show it'}
        >
          <span className="plan-mark" aria-hidden="true" />
          {/* The keyboard's way in, as on a task card: Enter presses it and the
              press bubbles to the head. */}
          <button type="button" className="session-name card-title">
            {title}
            <span className="sr-only">
              , {kind}, {caption}
              {needsYou > 0 && `, ${needsYou} needs you`}
            </span>
          </button>
          {needsYou > 0 && <span className="head-break" aria-hidden="true" />}
          {needsYou > 0 && <span className="needs-you">{needsYou} needs you</span>}
          {/* The folded count rides on the caption, so a folded group says what it
              is hiding before you point at it. */}
          <span className="repo-summary">{[caption, folded > 0 ? `${folded} folded` : undefined].filter(Boolean).join(' · ')}</span>
          <button
            className={`card-fold${expanded ? ' open' : ''}`}
            aria-expanded={expanded}
            title={expanded ? 'fold it away' : `show what is under it${folded > 0 ? ` — ${folded} folded` : ''}`}
            onClick={(event) => {
              // The head may open a drawer; unfolding must not also do that.
              event.stopPropagation();
              onToggle();
            }}
          >
            <Icon name="chevron" />
          </button>
        </div>
      </div>
      {children && <div className="plan-tasks">{children}</div>}
    </>
  );
}

/**
 * A section's heading in the drawer.
 *
 * `stackable` spells out what it means, because it is the one state here that is
 * not a board column: the work can start, cut from a blocker's branch that is
 * still in review.
 */
const GROUP_LABEL: Record<TicketGroup, string> = {
  'needs-you': 'needs you',
  startable: 'startable',
  stackable: 'stackable — on a PR still open',
  'in-progress': 'in progress',
  'in-review': 'in review',
  blocked: 'blocked',
  done: 'done',
};

/**
 * The plan opened: every ticket of the milestone, grouped by what it is waiting on.
 *
 * Read-only toward Notion. Every link out goes to the card, and nothing here
 * moves one — drift is shown, not fixed, because the board is the team's.
 */
export function PlanView({
  plan,
  rows,
  fetchedAt,
  stale,
  refreshing,
  onRefresh,
  onStart,
  onOpenTask,
  onResult,
}: {
  plan: Plan;
  rows: PlanTicket[];
  /** Epoch seconds the plans were read at. */
  fetchedAt: number;
  /** The last read failed, and this is the one before it. */
  stale?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onStart: (ticket: Ticket) => void;
  onOpenTask: (slug: string) => void;
  onResult: (message: string, ok: boolean) => void;
}): React.JSX.Element {
  const now = Math.floor(useNow(30_000) / 1000);
  const open = (url: string): void => {
    void send({ kind: 'openExternal', url }).then((result) => onResult(result.detail, result.ok));
  };

  return (
    <div className="plan-view">
      <div className="plan-view-head">
        {/* The name is already in the rail; this line is the counts, and the way
            out to the milestone itself. */}
        <button className="plan-view-name" onClick={() => open(plan.url)} title="open the milestone in Notion">
          {planCounts(rows).progress} <span aria-hidden="true">↗</span>
        </button>
        {/* Dated rather than hidden, like the quota gauges: a stale plan still
            says roughly where the milestone stands. */}
        {stale && (
          <span className="quota-stale" title="Notion did not answer the last read">
            as of {duration(now - fetchedAt)} ago
          </span>
        )}
        <button className="chip" disabled={refreshing} onClick={onRefresh} title="read the milestone from Notion again">
          {refreshing ? 'reading…' : 'refresh'}
        </button>
      </div>
      {rows.length === 0 && <div className="empty">no tickets read from this milestone</div>}
      {groupTickets(rows).map(({ group, tickets }) => (
        <section key={group} className="plan-group">
          <div className="section-title">
            {GROUP_LABEL[group]} · {tickets.length}
          </div>
          {tickets.map((row) => (
            <TicketRow key={row.ticket.id} row={row} onOpen={open} onStart={onStart} onOpenTask={onOpenTask} />
          ))}
        </section>
      ))}
    </div>
  );
}

function TicketRow({
  row,
  onOpen,
  onStart,
  onOpenTask,
}: {
  row: PlanTicket;
  onOpen: (url: string) => void;
  onStart: (ticket: Ticket) => void;
  onOpenTask: (slug: string) => void;
}): React.JSX.Element {
  const { ticket, link } = row;
  const assignees = ticket.assignees.map((assignee) => assignee.name).join(', ');
  const canStart = row.group === 'startable' || row.group === 'stackable';
  /*
   * Said once: the section heading already names the group, and the dot the
   * progress, so the meta line only adds who has it and — while nothing has
   * started — what it waits on. A landed ticket's old blockers are history.
   */
  const meta = [
    assignees || 'unassigned',
    row.status === 'not-started' && row.blockers.length > 0
      ? `blocked by ${row.blockers
          .map((blocker) => `${blocker.label} (${blocker.status ? STATUS_LABEL[blocker.status] : 'unknown'})`)
          .join(', ')}`
      : undefined,
  ].filter(Boolean);
  return (
    <div className={`plan-ticket${row.group === 'done' ? ' plan-ticket-done' : ''}`}>
      <div className="plan-ticket-line">
        <span className={`task-status-dot task-status-${row.status}`} title={STATUS_LABEL[row.status]} />
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
        {/* A marker, not a second stop: the id beside it opens the same card. */}
        {row.drift && (
          <span
            className="plan-drift"
            title={`Fleetwood reads ${STATUS_LABEL[row.status]}, the board says ${ticket.notionStatus} — open the card to move it`}
          >
            ≠ {ticket.notionStatus}
          </span>
        )}
        {link ? (
          <button className="chip" onClick={() => onOpenTask(link.task.slug)} title={`open ${link.task.slug}`}>
            task
          </button>
        ) : (
          row.status === 'not-started' && (
            /* Drawn on a blocked ticket too, dimmed, so the rule is on screen
               rather than the button simply missing. */
            <button
              className="chip"
              disabled={!canStart}
              onClick={() => canStart && onStart(ticket)}
              title={
                canStart
                  ? 'new task on this ticket — the branch carries its id'
                  : 'a blocker has no pull request yet, or is outside this milestone'
              }
            >
              start
            </button>
          )
        )}
      </div>
      <div className="plan-ticket-meta">{meta.join(' · ')}</div>
    </div>
  );
}
