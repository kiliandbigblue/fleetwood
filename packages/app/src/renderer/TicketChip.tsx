import { ticketVar } from './planHue.ts';

/**
 * A row's ticket id, in the column the session, worktree and pull request rows
 * of one task all share — so `DEV-1866` is matched across the three lists by
 * place and colour rather than by reading four digits out of a long name.
 *
 * The colour is the card's, not the id's: `ticketCardStyle` (in `planHue.ts`) sets one turn of
 * the wheel per ticket on the card, and the chip only names which one it reads.
 * A row with no id keeps the slot with a dim dash, so the gap reads as "no
 * ticket" rather than as a layout fault.
 */
export function TicketChip({ id, blank }: { id?: string; blank?: boolean }): React.JSX.Element {
  if (!id) {
    // `blank` for an agent at the task root: it works the task's ticket, not
    // none, so it holds the slot without the dash that would say otherwise.
    return (
      <span className="ticket-chip none" title={blank ? undefined : 'no ticket in this branch'}>
        {blank ? '' : '—'}
      </span>
    );
  }
  return (
    <span className="ticket-chip" style={{ '--ticket-turn': `var(${ticketVar(id)})` } as React.CSSProperties} title={id}>
      {id}
    </span>
  );
}
