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
hook state, a hook beats the screen, the screen beats a stale hook, and an
unreadable screen beats nothing at all.** Every status carries its provenance, and
inferred ones are marked (`~` screen, `?` process-only, `…` stale) so an inference
never looks as solid as a report. Durations say what they measure: a status nobody
timed is shown as uptime (`up 18h`), never as time spent working.

**Daemon-hosted sessions get a fourth source.** Claude Code can run a session
inside `claude daemon`'s own pty, with the tmux pane holding only a thin client
attached to it — that's what a session launched from `/` does. Both usual bindings
fail there: `$TMUX_PANE` is stripped from the worker's environment, and the worker
is reparented to init so the process tree stops at pid 1. Left at that, one agent
reads as two: a phantom in the pane, and a session apparently running nowhere. So
fleetwood reads the daemon's own roster (`~/.claude/daemon/roster.json`), which
maps a session id onto the process the agent really runs in, and matches it to the
pane displaying it by launch directory and CLI version — marked `⇢`, because that
pane was inferred rather than reported. A match counts only when it is the only
candidate on both sides; an ambiguous one is listed without a pane instead of
guessed onto the wrong terminal. `fw doctor` reports both numbers.

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

## CLI

```
fw                    the fleet (default)
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
