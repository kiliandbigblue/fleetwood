---
name: spawn-worktree
description: Spawn an isolated git worktree, a tmux session and a claude agent for one task. Use when asked to start, spawn, kick off, or fan out a new agent / task / worktree / session — "spawn a worktree for X", "start an agent on Y", "kick off a session to Z", "work on this in parallel".
---

# Spawn a worktree for a session of claude work

One task → one worktree → one tmux session → one `claude` running in it, stamped
so `fw` and the fleetwood app see it. Driven by a single script:

```
.claude/skills/spawn-worktree/spawn.mjs
```

Zero dependencies, shells out to `git` and `tmux`. It does **not** import
`@fleetwood/core` — it mirrors core's conventions instead, so it runs from any
repo without a build step. Paths below are relative to the repo root.

## Spawn (the main path)

```bash
node .claude/skills/spawn-worktree/spawn.mjs 'stale hook states' \
  -p 'a SIGKILLed agent never reports Stop; make dead-process beat hook state'
```

```
✓ worktree /Users/kiliandemeulemeester/projects/fleetwood/.agents/worktrees/stale-hook-states
  no origin remote — branched from local HEAD
✓ tmux session stale-hook-states
✓ claude starting in %35 with your prompt

  attach:  tmux attach -t stale-hook-states
  watch:   pnpm fw status
```

The task name is slugified into the branch, the directory and the session name.
Focus stays where you are, so spawning several in a row doesn't yank your
terminal around.

| Flag | Effect |
|---|---|
| `-p, --prompt <text>` | Initial prompt, passed as `claude`'s argv prompt |
| `--base <ref>` | Branch base (default: origin's default branch, else local `HEAD`) |
| `--branch <name>` | Branch name (default: the slug) |
| `--session <name>` | tmux session name (default: the slug) |
| `--repo <path>` | Repo to spawn from (default: the cwd's **main** worktree) |
| `--setup <cmd>` | Shell command run in the worktree before `claude` starts |
| `--no-agent` | Worktree + session only, pane left at a shell |
| `--focus` | Switch to the new session |
| `--json` | Machine-readable result |

`--setup` types a command into the pane before `claude` starts — use it to prove
the worktree is where you think it is, or to install deps:

```bash
node .claude/skills/spawn-worktree/spawn.mjs 'setup flag test' \
  --no-agent --setup 'git status --short --branch'
```

```
❯ git status --short --branch
## setup-flag-test
```

## Verify it landed

```bash
pnpm fw status
```

```
○ readme-typo-hunt worktree readme-typo-hunt ~/projects/fleetwood/.agents/worktrees/readme-typo-hunt 36s
    ○ idle       … %35  claude  29s   Read: README.md
```

Or read the pane directly, which is how you check on an agent without attaching:

```bash
tmux capture-pane -p -t readme-typo-hunt | tail -30
```

Raw stamps:

```bash
tmux show-options -t readme-typo-hunt | grep '@fw'
```

```
@fw_branch readme-typo-hunt
@fw_kind worktree
@fw_worktree /Users/kiliandemeulemeester/projects/fleetwood/.agents/worktrees/readme-typo-hunt
```

## Tear down

There is no `--rm`; removal is destructive and `git` already refuses to discard
uncommitted work, which is the safety you want:

```bash
tmux kill-session -t readme-typo-hunt
git worktree remove .agents/worktrees/readme-typo-hunt
git branch -d readme-typo-hunt
```

`git worktree remove` refuses while the worktree is dirty. Add `--force` only
when you mean to throw the agent's work away.

## Gotchas

- **`tmux display-message -t '=name'` exits 0 and prints an empty string.**
  Not an error — silence. A guard built on it passes when it should fail. The
  `=` exact-match prefix works for `has-session` / `list-panes` / `kill-session`
  but not here. `set-option -t` has the same allergy and at least fails loudly
  (`no such session: =name`, already noted in `packages/core/src/tmux.ts`).
  `spawn.mjs` uses the bare name for both, and its session-collision guard
  **fails closed** — an unreadable path is a refusal, not a pass. Getting this
  wrong stamped one session with another's `@fw_branch` during development.
- **This repo has no `origin` remote**, so the default base is local `HEAD`, not
  a fetched default branch — a spawned worktree inherits whatever is committed
  on your current `main`. The output line tells you which base was used every
  time; read it. Pass `--base` to override.
- **`SessionMeta.kind` has no `task` value.** The union in
  `packages/core/src/types.ts` is `project | pr | worktree | scratch`, so
  sessions are stamped `worktree`.
- **`@fw_repo` is omitted when there's no GitHub `origin`.** `fw sessions` then
  shows `worktree · <branch>` with no repo — that's correct, not a bug.
- **The session name is the slug on purpose.** It equals core's
  `sessionNameFor(worktreePath)`, so fleetwood's own find-or-create focuses this
  session instead of making a second one for the same directory. Overriding
  `--session` breaks that alignment.
- **The prompt goes in as `claude`'s argv, not typed after boot.**
  `actions.spawnAgent` in core admits it can't send a prompt because the agent
  may still be booting; `claude [prompt]` sidesteps the race entirely. The
  command is still *typed into a shell* rather than exec'd as the pane command,
  so the pane survives `claude` exiting and keeps its scrollback.
- **Spawning from inside a worktree still targets the main repo.** Resolution
  goes through `git rev-parse --git-common-dir`, not `--show-toplevel`; nesting
  worktrees produces a mess `git worktree remove` then won't clean up.
- **A fresh worktree has no `node_modules`.** Nothing installs by default —
  use `--setup`. For fleetwood specifically, `pnpm install` pulls electron,
  whose postinstall is fragile on this machine.
- **`--focus` is the one flag not exercised here**, because verifying it means
  yanking the attached terminal mid-session. It uses `switch-client` when
  `$TMUX` is set and `attach-session` otherwise; the default path prints the
  `tmux attach` line instead.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `branch X already exists but has no worktree` | The slug collides with an old branch. `--branch <other>`, or delete the branch. |
| `tmux session "X" already exists but sits in <other path>` | Slug collision across repos. `--session <other>`. |
| `"..." slugifies to nothing usable` | Task name had no letters or digits. |
| Re-running prints `• reusing …` and starts no second agent | Find-or-create working as intended. Spawning twice never gives two sessions. |
| Agent pane sits at a shell prompt | `claude` isn't on `PATH` for a non-interactive shell, or `--no-agent` was passed. |
