# fleetwood

A tmux-native cockpit for coordinating coding agents (Claude Code, cursor-agent, codex),
plus a GitHub facade that turns a pull request into a ready-to-work tmux session.

It answers one question at a glance: **what is every agent doing right now, and what needs me?**

```
fleetwood · 3 sessions · 2 working · 1 blocked

● fleetwood     ~/projects/fleetwood 2h
    ▶ working     %3   claude⤶ +2   4m    Bash: pnpm test
● atlas-pr-3671 pr fix/address-validation bigbluedisco/atlas#3671
    ✋ permission  %7   claude       12s   Write: validation.go
○ HOME          ~ 3h
    ○ idle        %0   claude       1h2m
```

## Design

**tmux is the source of truth.** Sessions, windows and panes are read straight from
tmux; fleetwood never keeps its own registry of them. Session metadata (which PR,
which branch, which worktree) is stamped onto the tmux session as user options
(`@fw_pr`, `@fw_repo`, `@fw_branch`, `@fw_worktree`, `@fw_kind`), so it survives
restarts and is inspectable with plain `tmux show-options`.

**Status comes from the agents themselves.** A tiny `sh` hook, installed alongside
whatever you already run, writes each agent event into `~/.fleetwood/spool/` and
exits. It does no JSON parsing — the collector folds the events. This is what makes
statuses precise instead of guessed: `PreToolUse` becomes `working` with the actual
command (`Bash: pnpm test`), `PermissionRequest` becomes `blocked_permission`,
`Stop` becomes `idle`.

The hook's real trick is `$TMUX_PANE`, inherited from the pane the agent was
launched in — that is what binds an agent session to a pane.

**Three sources, reconciled.** Hooks are precise but can go stale (an agent killed
with `SIGKILL` never reports it). So fleetwood also polls tmux, walks the process
tree, and reads pane contents. Precedence is explicit: **a dead process beats any
hook state, a hook beats the screen, and the screen beats a stale hook.** Every
status carries its provenance, and inferred ones are marked (`~` screen, `?`
process-only, `…` stale) so an inference never looks as solid as a report.

## What it gives you

- **Live agent status per pane** — working / needs-permission / waiting / idle /
  compacting / gone, with what the agent is doing, how long it's been in that
  state, its subagent count and error count.
- **Approve or deny from the panel.** A blocked agent's actual prompt is read off
  the pane and rendered with buttons; clicking one sends the keystroke. This is the
  feature that makes the app worth keeping open.
- **PR → session in one click.** Find-or-create: an existing session for that PR is
  focused, otherwise a dedicated git worktree and tmux session are built and stamped.
  Clicking twice never gives you two sessions.
- **Background and nested agents are found too.** Their hooks run without
  `$TMUX_PANE`, so fleetwood traces them to their pane through the process tree and
  marks them `⤶`.
- **A CLI with parity.** Everything the app can do, `fw` can do — so the
  worktree-spawning skills you write later drive the same code instead of
  reimplementing tmux plumbing.

## Setup

Requires tmux ≥ 3.0, Node ≥ 23.6 (it runs the TypeScript directly — no build step
for core or the CLI), and `gh` authenticated for the PR features.

```sh
pnpm install
pnpm fw install-hooks    # registers hooks with claude + cursor
pnpm fw doctor           # verifies the whole environment
```

`install-hooks` is **append-only and backed up**: it adds its own matcher group per
event and never rewrites existing entries, so anything you already run (peon-ping,
herdr) is left byte-identical. Backups land in `~/.fleetwood/backups/`. Codex is
reported, not edited — it's TOML, and a bad edit there breaks the agent, so the
exact line to add is printed instead.

Already-running agents keep their old config; new sessions pick the hooks up.

### The app

Install it as a normal macOS app — Dock, Spotlight, ⌘-Tab, Login Items:

```sh
pnpm --filter @fleetwood/app install-app    # → /Applications/Fleetwood.app
```

Or just build the bundle without installing:

```sh
pnpm --filter @fleetwood/app bundle         # → packages/app/release/Fleetwood.app
```

For development, run it from the checkout instead:

```sh
pnpm --filter @fleetwood/app dev
```

⌥⇧F toggles the window, ⌘K opens the palette (jump to a session, open a project),
⌘R refreshes. The tray title shows the fleet summary (`✋1`, `▶3`) so you can leave
the window closed. To have it start with your machine: System Settings → General →
Login Items → add Fleetwood.

The bundle is **signed ad-hoc**, which is all that's needed for an app built on the
machine that runs it: nothing downloads it, so Gatekeeper never quarantines it. It is
not notarised, so it will not run as-is on anyone else's Mac.

#### Two macOS packaging traps this repo works around

**A GUI launch has almost no PATH.** From the Dock or Spotlight an app inherits
launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not your shell's — so Homebrew's
`tmux` and `gh` are invisible and the app would show an empty fleet. `main/path.ts`
repairs it before the first tmux read: a static list of likely prefixes first, then a
login-shell probe merged in for anything unusual (mise, asdf, custom prefixes).

**`extract-zip` is broken on this machine**, which takes out both `electron`'s
postinstall and every packager built on it (`@electron/packager`, `electron-builder`)
— they download the 112MB zip fine and then produce a 14MB `dist` holding only a
licence file, exiting 0. So `scripts/make-app.mjs` assembles the bundle from the
already-extracted `Electron.app` in `node_modules`: rename the executable, rewrite
Info.plist, drop the code into `Contents/Resources/app`, re-sign. If Electron itself
won't install, extract it by hand:

```sh
cd node_modules/.pnpm/electron@*/node_modules/electron
ZIP=$(find ~/Library/Caches/electron -name "*.zip" -type f | head -1)
rm -rf dist && mkdir dist && unzip -q "$ZIP" -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
```

Also note pnpm 10 blocks postinstall scripts, so Electron's download is gated behind
`onlyBuiltDependencies` in `pnpm-workspace.yaml`.

## Tasks that span repos

Real work isn't repo-shaped. A change to `flow` touches `proto`, `graphy` and
`storage-bigquery-replication`, and you usually don't know the full set when you
start — so there is no good moment to decide which sessions to spawn.

A **task** is one branch, one tmux session, and a folder of real git worktrees:

```
~/projects/.agents/tasks/flow-execution-labels/
  TASK.md          the brief: goal, branch, repos
  proto/           worktree of ~/projects/proto   on fix/flow-execution-labels
  graphy/          worktree of ~/projects/graphy  on fix/flow-execution-labels
  api-scripts/     added later, one click
```

```sh
fw task new fix flow "execution labels" --repo proto --repo graphy
fw task add flow-execution-labels api-scripts    # grow it as the work reveals itself
fw task ls
fw task archive flow-execution-labels
```

The session's first window is rooted at the task folder, so **one agent can grep
and edit across every involved repo** — that's what removes the upfront guessing.
Add repo-scoped agents when you want per-repo context. ⌘T opens the form in the app.

Why it's built this way:

- **Real worktrees, not symlinks.** ripgrep doesn't follow symlinks, so a folder of
  symlinked repos would be invisible to Claude Code's Grep and Glob. Each entry is a
  genuine linked worktree — shared object store, tracked files only, ~50 MB for a
  repo whose full clone is 700 MB.
- **The folder is the record.** Repo membership is `readdir`; the branch comes from
  git. Only the immutable description lives in `task.json`, so nothing can drift.
- **One branch name across repos**, following `<type>/<microservice>-<summary>`.
  Since the microservice is a domain rather than a repo, the same name applies
  everywhere the change lands — which means
  `gh search prs "head:<branch>"` returns the task's whole PR set in one query,
  including PRs opened by someone else. The app shows that grouping in the PR tab.
- **Branch creation respects each repo's default branch** — `dev` for atlas/graphy/
  reflow, `master` for proto. Never assume `main`.
- **Archive prunes only empty branches**: no commits of its own and never pushed.
  Anything with work in it stays. The comparison is against `origin/<default>`,
  because a local default branch can be far behind (proto's was 45 commits stale,
  which made brand-new branches look used).

A task-root agent does **not** load each repo's `CLAUDE.md`/`AGENTS.md` or
`.claude/settings.local.json` at startup; `TASK.md` says so, and it picks them up
when it reads into a repo. Fresh worktrees have no `node_modules` (Go's module cache
is global, so Go builds work immediately).

## CLI

```
fw                    the fleet (default)
fw task ...           multi-repo tasks (see above)
fw watch              the fleet, refreshed live
fw agents             flat list, most urgent first
fw prs                PRs awaiting your review, and your own
fw open-pr <ref>      focus a PR's session, or build one on a fresh worktree
fw approve [pane]     answer yes to a blocked agent
fw deny [pane]        answer no
fw focus <session>    point the terminal at a session
fw sessions | panes | repos | doctor | install-hooks
```

`fw open-pr` takes `owner/repo#123` or a full PR URL.

## Layout

```
packages/core     tmux client, process scanner, event folding, github, worktrees
packages/hooks    the sh scripts installed into agent configs
packages/cli      the fw command
packages/app      Electron: main (which is also the collector) + React renderer
```

The Electron main process **is** the collector — there is no separate daemon to
babysit. Hook events accumulate in the spool while the app is closed and are folded
on next start, so no history is lost either way.

## Conventions worth knowing

- **Worktrees** live at `<repo>/.agents/worktrees/<slug>`, added to
  `.git/info/exclude` (local-only — never your tracked `.gitignore`). Removal
  refuses to discard uncommitted work unless forced.
- **Session names** match the existing `tmux-sessionizer` (`basename | tr . _`), so
  `prefix+g` and fleetwood always agree that a project has one session.
- **Agent detection reads full argv, never the process name.** Claude Code's pane
  process is the versioned binary, so `pane_current_command` is a version string
  like `2.1.220`; and a single session also spawns `claude daemon run` plus several
  `bg-pty-host` helpers that must not be counted as separate agents.
- **`set-option -t` rejects the `=` exact-match prefix** that `has-session`,
  `kill-session` and `new-window` accept (tmux 3.6a). Stamping metadata uses the
  bare session name for that reason.

## Tests

```sh
pnpm test        # node:test, no framework
pnpm typecheck
```

Covers the tmux format parsers, the process matcher (against real argv from live
sessions, decoys included), the event folder (one case per agent event, with
out-of-order delivery), the screen parser (against real box-drawn prompts), and the
git/GitHub plumbing.
