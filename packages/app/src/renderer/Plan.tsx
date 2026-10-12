import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Plan, PlanTicket, Ticket, TicketGroup } from '@fleetwood/core';
// The leaf modules: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { canStart, dueLabel, groupTickets, landed, STAGE } from '@fleetwood/core/plan';
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
  // Fleetwood's own count beside Notion's estimate-weighted percentage: the two
  // answer different questions, and this one knows about deploys.
  const counted = rows.filter((row) => row.stage !== 'canceled');
  const deployed = counted.filter((row) => row.stage === 'deployed').length;
  const caption = planCaption(plan, nowMs, [
    { text: `${deployed} of ${counted.length} deployed` },
    // Dated rather than hidden, like the quota gauges: a stale plan still says
    // roughly where the milestone stands.
    ...(stale
      ? [{ text: `as of ${duration(now - fetchedAt)} ago`, className: 'quota-stale', title: 'Notion did not answer the last read' }]
      : []),
  ]);

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
      {groupTickets(rows).map(({ group, tickets }) => {
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
 * One ticket, drawn as a fleet task is: its name and stage on the head, which
 * ticket and who is on it on the row under.
 *
 * The stage is one reading, from `todo` to `deployed`, instead of a dot, a
 * board column and a drift marker to reconcile. The row under says the task
 * working it, what its agent is doing, and `here` when your terminal is in it.
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
  // A landed blocker blocks nothing, and naming it beside the live one made the
  // ticket read as more stuck than it is.
  const blockers = row.blockers.filter((blocker) => !blocker.stage || !landed(blocker.stage));
  const head = link
    ? { go: () => onOpenTask(link.task.slug), says: `open the task ${link.task.slug}` }
    : { go: () => onOpen(ticket.url), says: `open ${ticket.id} in Notion` };
  return (
    <div className={`card plan-ticket${row.group === 'done' ? ' plan-ticket-done' : ''}${here ? ' here' : ''}`}>
      {/*
       * A fleet task's head: the mark, the name in the title face, and where it
       * has got to on the right edge. The head goes where a ticket lives — its
       * task when one works it, the card in Notion when none does.
       */}
      <div className="card-head" onClick={head.go} title={`${ticket.title} · ${head.says}`}>
        <span
          className={`task-status-dot task-status-${STAGE[row.stage].status}`}
          title={STATUS_LABEL[STAGE[row.stage].status]}
        />
        {/* The row's one keyboard stop, on the list's j/k walk; `owes` puts the
            ones waiting on you on `n`, as on the pull requests tab. */}
        <button type="button" className={`session-name card-title list-stop${row.group === 'needs-you' ? ' owes' : ''}`}>
          {ticket.title}
          <span className="sr-only">
            , {ticket.id}
            {here && ", you're here"}
          </span>
        </button>
        <span className="plan-stage" data-stage={row.stage}>
          {STAGE[row.stage].label}
          {row.prCount > 1 && ` · ${row.prCount} PRs`}
        </span>
        {canStart(row) && (
          /* Never withheld: a `Blocked by` line is a plan, not a lock, and the
             part of a ticket that waits on nothing can always start. */
          <button
            className="chip"
            onClick={(event) => {
              event.stopPropagation();
              onStart(ticket);
            }}
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
      {/* Under the name, on its rail, as a task's worktree rows are: which ticket,
          then who is on it. The separators are drawn by the stylesheet, so a part
          that has nothing to say simply is not here. */}
      <div className="plan-ticket-meta">
        <button className="plan-ticket-id" onClick={() => onOpen(ticket.url)} title={`open ${ticket.id} in Notion`}>
          {ticket.id}
        </button>
        {/* Named, not a second way in: the head already opens it. */}
        {link && <span className="plan-ticket-task">{link.task.slug}</span>}
        {here && <span className="plan-here">here</span>}
        {agent && <span className={agent.danger ? 'plan-alarm' : undefined}>{agent.text}</span>}
        {/* With a task linked it is yours; the name only matters on someone else's. */}
        {!link && <span>{assignees || 'unassigned'}</span>}
        {/* A landed ticket's old blockers are history; only a waiting one says them. */}
        {waiting && blockers.length > 0 && (
          <span>
            blocked by{' '}
            {blockers
              .map((blocker) => `${blocker.label} (${blocker.stage ? STAGE[blocker.stage].label : 'unknown'})`)
              .join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}
