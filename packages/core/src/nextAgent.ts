import { isBlocked } from './fleet.ts';
import type { FleetAgent, FleetSession } from './fleet.ts';
import { live, rankedSessions } from './switchTargets.ts';

/*
 * What `fw next` (⌘J / ⌘⇧J) jumps to: the agent after the pane you are in.
 *
 * Sessions in `prefix+g`'s order, but agents inside one in pane order rather
 * than the picker's urgency order: answering a prompt changes its agent's
 * urgency, and a ring that reshuffles under you revisits agents you just left.
 * It wraps, so pressing again keeps walking the fleet. One stop per pane: a
 * nested agent shares its parent's, and stopping twice there would read as the
 * key doing nothing.
 */
export interface NextAgent {
  agent: FleetAgent & { pane: string };
  session: FleetSession;
}

export function nextAgent(
  sessions: readonly FleetSession[],
  fromPane: string | undefined,
  blockedOnly: boolean,
): NextAgent | undefined {
  const ring: NextAgent[] = [];
  const panes = new Set<string>();
  for (const session of rankedSessions(sessions)) {
    for (const agent of session.agents.filter(live)) {
      const pane = agent.pane as string;
      if (panes.has(pane)) continue;
      panes.add(pane);
      ring.push({ agent: { ...agent, pane }, session });
    }
  }
  const from = ring.findIndex((r) => r.agent.pane === fromPane);
  // Off the ring (a plain shell, or nothing passed) starts from the top.
  for (let step = 1; step <= ring.length; step++) {
    const next = ring[(from + step) % ring.length] as NextAgent;
    if (next.agent.pane === fromPane) continue;
    if (!blockedOnly || isBlocked(next.agent.status)) return next;
  }
  return undefined;
}
