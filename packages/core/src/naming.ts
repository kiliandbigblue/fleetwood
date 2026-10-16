/*
 * The naming conventions, in one leaf module.
 *
 * Pure string rules with no `node:` imports, because both front ends need them
 * and the renderer cannot reach `task.ts` — it pulls in `node:fs` and takes the
 * bundle down. That is the same reason `taskView.ts` exists. Before this, the
 * new-task flow kept its own copy of `slugify` and `buildBranch`, held to these
 * by a test; the copy is gone and the test with it.
 */

/** Git ref names forbid a lot; keep to lowercase kebab and nothing surprising. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The kinds of change a branch can be, and the first segment of its name.
 *
 * Here rather than in the panel that first had them, for the reason the rest of
 * this module is here: the tmux popup asks the same question, and a second copy
 * of the list is a second place to forget to add one. `buildBranch` still
 * accepts anything sluggable — this is what the pickers offer, not a validator.
 */
export const TASK_TYPES = ['feature', 'fix', 'chore'] as const;

/**
 * Build the branch name from the convention `<type>/<microservice>-<summary>`.
 *
 * The microservice is a domain rather than a repo, which is exactly why the same
 * name is reused across every repo a change touches.
 */
export function buildBranch(type: string, microservice: string, summary: string): string {
  const kind = slugify(type) || 'feature';
  const rest = [slugify(microservice), slugify(summary)].filter((p) => p.length > 0).join('-');
  return `${kind}/${rest}`;
}

/** Task folder name: the branch without its type prefix. */
export function branchToSlug(branch: string): string {
  const withoutType = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch;
  return slugify(withoutType);
}

/**
 * What one worktree is called inside a task folder: the repo and the branch.
 *
 * Both, always, because a task folder holds *worktrees* and a worktree is a repo
 * and a branch together. Naming it after the repo alone was the assumption that
 * a repo appears at most once — which stacked work breaks: one change becomes
 * four branches in `reflow`, each needing its own checkout, and all four wanted
 * the same directory. The second one silently got the first one's branch back.
 *
 * The cost is a little redundancy on a single-branch task
 * (`ui-pr-links/fleetwood-ui-pr-links`), and the gain is that the name never
 * depends on what was added first, never has to change when a second branch
 * joins, and always says which layer you are standing in.
 */
export function worktreeDirName(repoName: string, branch: string): string {
  const slug = branchToSlug(branch);
  return slug.length > 0 ? `${repoName}-${slug}` : repoName;
}

/**
 * Whether a worktree has drifted off the branch it was made for.
 *
 * Not simply "its branch differs from the task's": every layer of a stack does,
 * deliberately, and flagging all of them made the warning mean nothing. Since a
 * directory is now named for its branch, the name is the record of what was
 * intended there — so drift is a branch the directory does not claim. Legacy
 * worktrees named after the repo alone are covered by the first test, which is
 * what they were created for.
 */
export function hasDriftedOffBranch(dirName: string, branch: string | undefined, taskBranch: string): boolean {
  // A branch we could not read is not evidence of drift — only one we read and
  // which nothing accounts for.
  if (branch === undefined) return false;
  if (branch === taskBranch) return false;
  const slug = branchToSlug(branch);
  return !(dirName === slug || dirName.endsWith(`-${slug}`));
}

/**
 * A worktree's name with the task's own slug taken off it, when it carries one.
 *
 * On a plain task the directory is the repo and the task's branch together —
 * `atlas-ui-receive-receive-item-into-rebin-or-mono-item` under a card headed
 * `receive-receive-item-into-rebin-or-mono-item` — so every row reads the same
 * words back, and in a panel this narrow the distinguishing part is the part
 * that runs out of room. The task slug is what the heading already says, so the
 * task slug is what comes off.
 *
 * **Only** the task slug. A stack is several worktrees of one repo, each named
 * for its *own* branch, and there the suffix is the entire distinction: strip it
 * and a seven-worktree task reads `reflow`, `reflow`, `reflow`, `reflow`,
 * `reflow` — five rows that are visibly the same and actually five different
 * branches. That is worse than the repetition this function exists to remove,
 * so a name that does not end in the task's slug is returned whole.
 *
 * Never returns the empty string: a name is the only thing identifying the row.
 */
export function worktreeShortName(dirName: string, taskSlug: string): string {
  if (taskSlug.length === 0) return dirName;
  const suffix = `-${taskSlug}`;
  if (!dirName.endsWith(suffix) || dirName.length === suffix.length) return dirName;
  return dirName.slice(0, -suffix.length);
}

/**
 * The ticket a task works, off its slug or its branch.
 *
 * Case-insensitive, and returned upper-case: fw branches carry `dev-1735`
 * because `slugify` lowers everything, while Notion and every pull request seen
 * linked so far write `DEV-1735`. Bounded on the left, so a word that merely
 * ends in `dev` (`kdev-2`) is not read as a ticket.
 */
export function ticketIdOf(text: string): string | undefined {
  return ticketIdsIn(text)[0];
}

/**
 * Every ticket id in a run of text, in order, by the same rule as `ticketIdOf` —
 * so a `Blocked by` line and a branch name can never disagree on what an id is.
 */
export function ticketIdsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[^a-z0-9])dev-(\d+)/gi)].map((match) => `DEV-${match[1]}`);
}

/**
 * A name with everything up to its ticket id taken off: `atlas-dev-1866-merchants-…`
 * and `feature/DEV-1866-merchants-…` both read `merchants-…`.
 *
 * For rows that show the id in a chip of their own, where the repo, the type
 * prefix and the id were the same words three times before the part that tells
 * two rows apart. Only a slug-like prefix comes off — nothing with a space in
 * it — so a human pull request title (`Fix DEV-1866 flow`) is not cut.
 *
 * Undefined when there is nothing to take off, or nothing would be left: the
 * caller's own name for the row is then the right one, and which it is differs
 * by row.
 */
export function withoutTicketPrefix(name: string): string | undefined {
  const match = /^(?:[a-z0-9/_.-]*[^a-z0-9\s])?dev-\d+[^a-z0-9]*/i.exec(name);
  if (!match || match[0].length === name.length) return undefined;
  return name.slice(match[0].length);
}

/**
 * The ticket a pull request works: its branch's id, else its title's.
 *
 * The branch first because fw writes it; the title for the pull requests opened
 * by hand on a branch that never carried one.
 */
export function prTicketId(pr: { branch?: string; title: string }): string | undefined {
  return ticketIdOf(pr.branch ?? '') ?? ticketIdOf(pr.title);
}
