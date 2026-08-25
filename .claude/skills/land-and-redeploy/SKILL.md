---
name: land-and-redeploy
description: Take finished work in a fleetwood worktree all the way to the app Kilian is looking at — commit it, land it on main without a PR, rebuild and reinstall /Applications/Fleetwood.app, relaunch. Use for "commit then integrate to main then redeploy", "land this and restart the app", "ship this to my app", "commit, merge, redeploy".
---

# Land it, then redeploy

One gesture, three phases, in this order and no other:

1. **Commit** the work where it lives.
2. **Land it on `main`** — no PR, no review. This is `/integrate-to-main`.
3. **Redeploy** `/Applications/Fleetwood.app` from `main`. This is `relaunch-app`.

The two existing skills own the details and are the source of truth for them:
`/integrate-to-main` (global, `~/.claude/skills/`) for phases 1–2, and
`relaunch-app` (this repo, beside this file) for phase 3. **Read them** — don't
reimplement them from this file. What this skill adds is the seam between them,
which is where the mistakes actually happen.

Skipping review is the point of this flow, not an oversight. That means the checks
in phase 2 are the only thing between the work and `main`, so they are not
optional and a red one stops the whole chain — including the redeploy. Landing a
broken build and then installing it over the app the user is watching is strictly
worse than stopping and saying so.

## The seam that goes wrong

**Phase 3 runs from `~/projects/fleetwood`, not from where you did the work.**
`install-app` builds from the cwd and overwrites the one app in `/Applications`, so
running it from a task worktree or a `.agents/worktrees/` checkout installs *that
branch's* code — the code you just merged, but by accident and from the wrong
place, and with whatever uncommitted mess that tree still holds. After the merge,
move to the main checkout and stay there:

```bash
git -C ~/projects/fleetwood log --oneline -1   # your commit should be HEAD
cd ~/projects/fleetwood
```

`main` is checked out there and nowhere else, which is also why phase 2 merges with
`git -C ~/projects/fleetwood merge --ff-only <branch>` instead of checking `main`
out where you are.

## The rest of the chain, briefly

| Phase | Command | Watch for |
|---|---|---|
| 1 | `git add` + `git commit -F <file>` | Zero commits ahead with everything uncommitted is the normal case here, not an error — commit first, then say so in the report. |
| 2 | `pnpm typecheck && pnpm test`, then `merge --ff-only` | Red stops the chain. Not fast-forwardable means `main` moved — ask, don't pick. |
| 2 | — | **There is no remote.** Nothing to push, and nothing to say about pushing. |
| 3 | `osascript -e 'quit app "Fleetwood"'` | Quit *before* installing: `install-app` `rm -rf`s the live bundle. |
| 3 | `pnpm --filter @fleetwood/app install-app` | ~20s, no sudo, no prompts. |
| 3 | `open -a /Applications/Fleetwood.app` | Exits 0 for a bundle that dies a second later — verify by process, not by `open`. |

Then re-verify: a fresh timestamp on
`/Applications/Fleetwood.app/Contents/Resources/app/dist/main/index.cjs`, and a
renderer process actually alive —

```bash
ps ax -o pid,command | grep '[F]leetwood.app' | cut -c1-90
```

Main + GPU + network + renderer helpers is healthy. Main alone means the window
never came up: read the failure, don't call it shipped.

## Report

Lead with the SHA on `main`, whether the checks were green, and that the installed
app is running the new code. Then flag, separately, anything the user would
reasonably have assumed and that isn't true — work that wasn't committed when they
thought it was, a check you couldn't run, a repo in the task that had nothing to
land.

Leave the branch and the worktree alone. Mention that they're still there and
offer to clean up; never do it unasked.

## When working from a task folder

`~/projects/.agents/tasks/<slug>/` does not load this repo's `.claude/`, so this
skill won't be listed there — the user invoking it by name is the signal to open
this file and follow it anyway. Everything above still applies verbatim, including
the part where phase 3 leaves the task folder for `~/projects/fleetwood`.
