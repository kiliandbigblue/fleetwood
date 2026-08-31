import type { FleetSession, Task } from '@fleetwood/core';

/**
 * Which task the panel is focused on, resolved against the snapshot that just
 * landed.
 *
 * Focus is held as a slug rather than as the `Task` itself, and this is why: a
 * snapshot arrives every second and replaces every object in it, so a held
 * reference would show the task as it was when you clicked. The slug is the only
 * part of a task that survives a re-read, so it is the handle — and this is the
 * one place that turns it back into the pair the pane needs.
 *
 * `undefined` is also the answer when the task is gone: archived from here, or
 * from `fw` in the terminal beside the panel. `App` reads that as "back to the
 * fleet", which is the only honest thing to do with a pane about nothing.
 *
 * No React, so `packages/app/test` can drive the archived-under-you case without
 * a DOM — it is the one that cannot be reproduced by clicking.
 */
export function resolveFocus(
  tasks: Task[] | undefined,
  sessions: FleetSession[],
  slug: string | undefined,
): { task: Task; session?: FleetSession } | undefined {
  if (!slug) return undefined;
  const task = tasks?.find((candidate) => candidate.slug === slug);
  if (!task) return undefined;
  // A dormant task has no session name to look one up by, and that is a state the
  // pane draws rather than a lookup that failed.
  const session = task.session
    ? sessions.find((candidate) => candidate.name === task.session)
    : undefined;
  return { task, session };
}
