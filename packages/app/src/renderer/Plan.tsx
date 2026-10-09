import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Plan, PlanTicket, Ticket, TicketGroup } from '@fleetwood/core';
// The leaf modules: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { canStart, dueLabel, groupTickets, STAGE } from '@fleetwood/core/plan';
import { STATUS_LABEL } from '@fleetwood/core/taskStatus';
import { agentWord } from './fleetSignals.ts';
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
  const percent = plan.progress !== undefined ? `${Math.round(plan.progress)}%` : undefined;
  const due = plan.targetDate ? dueLabel(plan.targetDate, now) : undefined;
  return (
    <GroupRow
      title={plan.name}
      kind="plan"
      summary={
        <span className="plan-caption">
          {plan.progress !== undefined && <Meter value={plan.progress} />}
          {percent && <span>{percent}</span>}
          {due && <span className={due.late ? 'plan-alarm' : undefined}>{due.text}</span>}
        </span>
      }
      spoken={[percent, due?.text].filter(Boolean).join(', ')}
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
  summary,
  spoken,
  expanded,
  folded,
  onToggle,
  onOpen,
  children,
}: {
  title: string;
  /** What a screen reader hears the row is. */
  kind?: string;
  /** The caption on the head's right edge. */
  summary: ReactNode;
  /** The caption in words, for a screen reader. */
  spoken: string;
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
          title={onOpen ? 'open the plan — every ticket, and where each one has got to' : expanded ? 'fold it away' : 'show it'}
        >
          <span className="plan-mark" aria-hidden="true" />
          {/* The keyboard's way in, as on a task card: Enter presses it and the
              press bubbles to the head. */}
          <button type="button" className="session-name card-title">
            {title}
            <span className="sr-only">
              , {kind}
              {spoken && `, ${spoken}`}
            </span>
          </button>
          <span className="repo-summary">{summary}</span>
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
 * The milestone's progress as a bar. Hidden from a screen reader: the number
 * beside it says the same, and is what gets read.
 */
function Meter({ value, wide = false }: { value: number; wide?: boolean }): React.JSX.Element {
  return (
    <span className={`plan-meter${wide ? ' wide' : ''}${value >= 100 ? ' full' : ''}`} aria-hidden="true">
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
 * The plan opened: every ticket of the milestone, grouped by what it is waiting on.
 *
 * Read-only toward Notion. Every link out goes to the card, and nothing here
 * moves one: the board is the team's.
 */
export function PlanView({
  plan,
  rows,
  fetchedAt,
  stale,
  refreshing,
  currentSession,
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
  /** The tmux session your terminal is on, to mark the ticket you are working. */
  currentSession?: string;
  onRefresh: () => void;
  onStart: (ticket: Ticket) => void;
  onOpenTask: (slug: string) => void;
  onResult: (message: string, ok: boolean) => void;
}): React.JSX.Element {
  const nowMs = useNow(30_000);
  const now = Math.floor(nowMs / 1000);
  // Shipped work is the bulk of a milestone by its end, and asks nothing.
  const [showDone, setShowDone] = useState(false);
  const open = (url: string): void => {
    void send({ kind: 'openExternal', url }).then((result) => onResult(result.detail, result.ok));
  };
  const due = plan.targetDate ? dueLabel(plan.targetDate, nowMs) : undefined;
  // Fleetwood's own count beside Notion's estimate-weighted percentage: the two
  // answer different questions, and this one knows about deploys.
  const counted = rows.filter((row) => row.stage !== 'canceled');
  const deployed = counted.filter((row) => row.stage === 'deployed').length;

  return (
    <div className="plan-view">
      <div className="plan-view-head">
        <button className="plan-view-name" onClick={() => open(plan.url)} title="open the milestone in Notion">
          {/* Bound to the last word, so the arrow never wraps onto a line alone. */}
          {plan.name}
          {'\u00a0'}
          <span aria-hidden="true">↗</span>
        </button>
        <div className="plan-view-facts">
          {plan.progress !== undefined && (
            <span className="plan-view-progress">
              <Meter value={plan.progress} wide />
              {Math.round(plan.progress)}%
            </span>
          )}
          {due && <span className={due.late ? 'plan-alarm' : undefined}>{due.text}</span>}
          <span>
            {deployed} of {counted.length} deployed
          </span>
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
      </div>
      {rows.length === 0 && <div className="empty">no tickets read from this milestone</div>}
      {groupTickets(rows).map(({ group, tickets }) => {
        const folds = group === 'done';
        return (
          <section key={group} className="plan-group">
            {folds ? (
              <button
                className={`section-title plan-fold${showDone ? ' open' : ''}`}
                aria-expanded={showDone}
                onClick={() => setShowDone(!showDone)}
              >
                {GROUP_LABEL[group]} · {tickets.length}
                <Icon name="chevron" />
              </button>
            ) : (
              <div className="section-title">
                {GROUP_LABEL[group]} · {tickets.length}
              </div>
            )}
            {(!folds || showDone) &&
              tickets.map((row) => (
                <TicketRow
                  key={row.ticket.id}
                  row={row}
                  here={row.link?.task.session !== undefined && row.link.task.session === currentSession}
                  onOpen={open}
                  onStart={onStart}
                  onOpenTask={onOpenTask}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * One ticket: what it is on the first line, where it has got to on the second.
 *
 * The second line leads with the stage in words — one reading, from `todo` to
 * `deployed`, instead of a dot, a board column and a drift marker to reconcile —
 * then who is on it: the task working it, what its agent is doing, and `here`
 * when your terminal is in that task.
 */
function TicketRow({
  row,
  here,
  onOpen,
  onStart,
  onOpenTask,
}: {
  row: PlanTicket;
  here: boolean;
  onOpen: (url: string) => void;
  onStart: (ticket: Ticket) => void;
  onOpenTask: (slug: string) => void;
}): React.JSX.Element {
  const { ticket, link } = row;
  const assignees = ticket.assignees.map((assignee) => assignee.name).join(', ');
  const waiting = STAGE[row.stage].status === 'not-started';
  const agent = link ? agentWord(link.agents, link.task.session !== undefined) : undefined;
  return (
    <div className={`plan-ticket${row.group === 'done' ? ' plan-ticket-done' : ''}${here ? ' here' : ''}`}>
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
        {canStart(row) && (
          /* Never withheld: a `Blocked by` line is a plan, not a lock, and the
             part of a ticket that waits on nothing can always start. */
          <button
            className="chip"
            onClick={() => onStart(ticket)}
            title={
              row.group === 'blocked'
                ? 'new task on this ticket — a blocker has no pull request yet, so stack or stub what it needs'
                : 'new task on this ticket — the branch carries its id'
            }
          >
            start
          </button>
        )}
      </div>
      {/* Where it has got to, then who is on it. The separators are drawn by
          the stylesheet, so a part that has nothing to say simply is not here. */}
      <div className="plan-ticket-meta">
        <span className="plan-stage" data-stage={row.stage}>
          {STAGE[row.stage].label}
          {row.prCount > 1 && ` · ${row.prCount} PRs`}
        </span>
        {link && (
          <button
            className="plan-ticket-task"
            onClick={() => onOpenTask(link.task.slug)}
            title={`open the task ${link.task.slug}`}
          >
            {link.task.slug}
          </button>
        )}
        {here && <span className="plan-here">here</span>}
        {agent && <span className={agent.danger ? 'plan-alarm' : undefined}>{agent.text}</span>}
        {/* With a task linked it is yours; the name only matters on someone else's. */}
        {!link && <span>{assignees || 'unassigned'}</span>}
        {/* A landed ticket's old blockers are history; only a waiting one says them. */}
        {waiting && row.blockers.length > 0 && (
          <span>
            blocked by{' '}
            {row.blockers
              .map((blocker) => `${blocker.label} (${blocker.stage ? STAGE[blocker.stage].label : 'unknown'})`)
              .join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}
