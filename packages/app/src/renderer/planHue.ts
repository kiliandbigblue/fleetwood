/**
 * A plan's hue, in degrees, so two milestones read apart before either name is
 * read — the way Linear colours a project.
 *
 * Only the hue is chosen here. Lightness and chroma are the theme's accent's,
 * in `styles.css`, so a plan's colour sits in whatever theme is on rather than
 * being a twelfth colour the theme never agreed to.
 *
 * A hash of the milestone id and nothing else, so a plan keeps its colour
 * across restarts and whatever other plans come and go. Two plans can land
 * close on the wheel; their names still tell them apart.
 */
export function planHue(milestoneId: string): number {
  return hash(milestoneId) % 360;
}

/** FNV-1a: spreads ids that differ in one character across the wheel. */
function hash(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

/** The custom property a ticket's turn is kept in on its card. */
export function ticketVar(id: string): string {
  return `--ticket-${id}`;
}

/**
 * The card-wide half of the ticket column, as custom properties on the card —
 * from `cardTickets`, which has them distinct and sorted.
 *
 * Hues only for two tickets or more: one has nothing to be matched against, so
 * its chips stay the card's grey (see `.tickets-hued`). By rank, not by hash. A hash gave sibling tickets — which have
 * consecutive ids, the normal shape of a task — the same colour two pairs at a
 * time (1865 and 1867 two degrees apart), so the colour promised a match it
 * did not keep. Matching only ever happens inside one card, so spacing the
 * card's own tickets evenly round the wheel is all the stability it needs. The
 * first is turned by nothing, so the lowest id — usually the task's own —
 * wears the accent its heading link does.
 *
 * Also the repo tag's width, from the longest one on the card, so the names
 * after it start on one line whichever repo a row is in.
 */
export function ticketCardStyle(tickets: string[], repoTags: string[]): Record<string, number> {
  const style: Record<string, number> = {
    '--repo-ch': Math.max(0, ...repoTags.map((tag) => tag.length)),
  };
  if (tickets.length < 2) return style;
  tickets.forEach((id, rank) => {
    style[ticketVar(id)] = (rank * 360) / tickets.length;
  });
  return style;
}
