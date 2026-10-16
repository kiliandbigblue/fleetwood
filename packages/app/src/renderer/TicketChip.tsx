import { planHue } from './planHue.ts';

/**
 * A row's ticket id, in the column the session, worktree and pull request rows
 * of one task all share — so `DEV-1866` is matched across the three lists by
 * place and colour rather than by reading four digits out of a long name.
 *
 * Coloured by the hash a plan is, and for the same reason: the same id lands on
 * the same hue in every list and after every restart. A row with no id keeps
 * the slot, empty, so the names after it still line up.
 */
export function TicketChip({ id }: { id?: string }): React.JSX.Element {
  return (
    <span
      className="ticket-chip"
      style={id ? ({ '--ticket-h': planHue(id) } as React.CSSProperties) : undefined}
      title={id}
    >
      {id}
    </span>
  );
}
