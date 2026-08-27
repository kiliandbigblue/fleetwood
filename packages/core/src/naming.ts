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
