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
