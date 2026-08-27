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

**Runway is measured, spend is not.** Fleetwood used to price every agent off its
transcript and show the dollars per row, per session and per fleet. It doesn't any
more, in either front end: what an agent has already spent is history, no control
here makes it smaller, and it sat next to the one figure that does change what you
do next. So the question this answers is how much runway is left, and nothing else
about money.

That number isn't on disk — the plan's usage windows come from the same endpoint
`/usage` uses. It needs an OAuth credential, so **fleetwood ships no credential
reader of its own**: you set `limits.tokenCommand` to a command that prints
yours, and the feature is inert until you do. It cannot take the panel down
either. An endpoint that changed shape yields an empty gauge, and a failed poll
keeps the last bars with an "as of" note rather than blanking them. The gauge
shows the window closest to stopping you rather than the first one, because a
session at 20% while the week sits at 94% reads green right up to the stall.

**"Deployed" is mostly not a fact GitHub holds, so the badge doesn't claim it.**
Across every repo here there are no Deployments-API entries and no job-level
`environment:` — for the Go services deploying *is* a human running `kubectl`, and
nothing writes that down. What GitHub does hold is the workflow runs on the merge
commit, and those separate the two shapes cleanly: a merge to `dev` runs the
checks, `Autotag` cuts a `vX.Y.Z`, and the tag triggers the image build — whereas
a frontend merge runs a deploy and is simply live. So the badge reports where the
trail stopped. `image built · deploy it` means an image exists in
`eu.gcr.io/bigblue-docker` and nobody has shipped it; `deployed` means a deploy
run actually succeeded. The distinction is the whole point, which is why it is
never collapsed into one green tick.

The load-bearing detail is that a tag-triggered build still carries the **merge
commit** as its head SHA, because the tag points at it — so one
`gh run list --commit` sees the entire test → autotag → build chain and hands back
the tag name with it. Querying the branch ref would miss the build entirely.
Reading the *names* of those runs is what assigns roles, deploy before build, so
`build_and_deploy` is a deploy rather than something you are told to go and ship.
A *build* means the run that produces the deployable image, and only that. `atlas`
fires three workflows off the same tag — `Docker build`, `Copy Go bindings to
atlas-proto-go`, `Node.js Package` — and the latter two publish libraries. They
share a commit, a tag and a creation second, so if the pattern matches them too
the badge reports whichever GitHub happens to list first.

Marking is deliberately not dismissing. A row that disappears is a row you can no
longer check, and the moment you want to check is exactly when you are about to
post to Slack — so the list keeps everything inside the lookback window and only
changes the order. The mark also never overwrites the CI reading: the badge says
`deployed by hand`, and what CI actually got as far as stays in the tooltip, which
is what you want on the day a mark turns out to be wrong.

Three honest limits: right after a merge an absent build means "not yet" rather
than "never", so there is a settle window before silence is reported as `no CI
trail`; a red check counts as a failure because it means `Autotag` never fires, so
no tag and no image are coming; and a repo whose workflow name says nothing
(`storage-mysql-bridge` calls its build-and-deploy `CI`) needs a pattern override
in `github.merged.repos` rather than a wrong badge.

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
- **How much runway is left**, as the plan's usage windows — one gauge in the
  panel's bottom rail that expands into all of them, and `fw limits` in the
  terminal. It is the only money-shaped number here; per-agent spend is gone.
- **Approve or deny from the panel.** A blocked agent's actual prompt is read off
  the pane and rendered with buttons; clicking one sends the keystroke. This is the
  feature that makes the app worth keeping open.
- **Close one agent, not its session.** A session that holds several agents — a
  task root plus its per-repo agents, or an agent and the background one it spawned
  — has no single kill switch that means the right thing, so every agent row has
  its own. It ends the agent's *process*, so the pane keeps its shell and its
  scrollback: the transcript of what it did is still there to read. Which process
  that is differs per case, and getting it wrong would close somebody else's
  agent: a daemon-hosted agent dies with its worker (its `$CLAUDE_PID` is a pooled
  helper that outlives it), and a nested one only by the pid it reported itself
  (the pane's outermost process is its parent). SIGTERM first, SIGKILL if it's
  ignored — and the toast says which.
- **What you merged, and whether it still needs shipping.** The PR tab's first
  section is your recent merges, badged with what CI did with the merge commit —
  so you never announce a change on Slack that was never deployed, or announce it
  while the build is still running. `⬆ image built · deploy it` is the one that
  means work; the header carries the count so it reaches you from any tab. When
  you have shipped one, **mark it deployed** — the row keeps its place in the list
  and its CI history, changes to `✔ deployed by hand`, and sinks below the ones
  still owed. Nothing is ever hidden: what is outstanding is simply on top.
- **What each task has open on GitHub**, on the task's own card — found from its
  worktrees' branches, stacks included, so a four-PR stack lists bottom-first
  instead of living in a note you typed yourself. See **Tasks that span repos**.
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

⌥⇧F toggles the window, ⌘K opens the palette (jump to a session, open a project,
start a task), ⌘R refreshes. The tray title shows the fleet summary (`✋1`, `▶3`) so
you can leave the window closed. To have it start with your machine: System
Settings → General → Login Items → add Fleetwood.

The bundle is **signed ad-hoc**, which is all that's needed for an app built on the
machine that runs it: nothing downloads it, so Gatekeeper never quarantines it. It is
not notarised, so it will not run as-is on anyone else's Mac.

### Themes

The `◐` button in the header switches palette. Eight flavours across three
families — Rosé Pine (main, moon), Catppuccin (mocha, macchiato, frappé) and Tokyo
Night (night, storm, moon) — with Rosé Pine main the default, because that is what
the tmux status line runs.

The choice is one `theme` key in `~/.fleetwood/config.json`, so **`fw` paints in it
too**. That is the point of the setting rather than a bonus: this panel lives beside
the terminal all day, and `fw status` printed in a different palette than the window
next to it is the exact clash worth ending. Editing the key by hand works — the panel
picks it up on its next poll, no relaunch — and an unknown name falls back to the
default rather than painting nothing.

The `background` slider at the foot of the same popover sets how much of the
desktop shows through — 100% down to 20%, live as you drag, saved as a `bgOpacity`
key beside `theme`. That one is the panel's alone: a terminal's transparency is the
terminal's setting, so `fw` has no use for it.

Only two of the eleven roles thin out, `bg` and `panel`. Text, accents and borders
stay solid at every setting, because the point is to see the desktop through the
window rather than to read the window through itself — and card fills derived from
`panel` inherit the alpha for free, so a card still reads as a layer over the
window instead of a solid slab on a see-through one. The theme popover itself is
the one deliberate exception, pinned opaque: it is the only floating surface with
no dimming backdrop under it, and a slider you cannot read at the setting it just
applied is one you cannot use to get back.

Electron fixes window transparency **at creation**, so the window is always
created transparent and contributes no fill of its own; every pixel of background
comes from the renderer, which is what makes the slider immediate instead of
needing a relaunch. At the default opacity of 1 that is indistinguishable from
before, with one exception — macOS draws no native drop shadow on a transparent
window, so `.app` carries a 1px CSS ring in its place.

Adding a theme is **data, not CSS**. `packages/core/src/theme.ts` maps each palette
onto eleven roles named for their job (`bg`, `panel`, `edge`, `dim`, `soft`, `text`,
`danger`, `warn`, `ok`, `accent`, `branch`); the renderer writes them onto the
document as custom properties and the CLI as truecolor escapes. Nothing below
`:root` in `styles.css` names a colour.

The values are the upstream palettes exactly as the neovim plugins define them
(`rose-pine/palette.lua`, `catppuccin/palettes/*.lua`, `tokyonight/colors/*.lua`),
because matching the editor is the whole job and a hand-mixed near-miss is what
reads as wrong. Ghostty's theme files were the other candidate and are not enough —
sixteen ANSI slots and a background, with nothing for the layered surfaces a card
needs. The per-family comments in `theme.ts` record how each palette's greys and
accents were read onto the roles.

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
  TASK.md                          the brief: goal, branch, repos (generated)
  NOTES.md                         your own notes, typed in the panel (never rewritten)
  proto-flow-execution-labels/     worktree of ~/projects/proto
  graphy-flow-execution-labels/    worktree of ~/projects/graphy
  api-scripts-flow-execution-labels/   added later, one click
```

A directory is named `<repo>-<branch slug>`, both halves always, because what a
task folder holds is *worktrees* and a worktree is a repo and a branch together.
Naming it after the repo alone assumed a repo appears at most once — which is
exactly what **stacked work** breaks: one change becomes four branches in `reflow`,
each needing its own checkout, and all four wanted the same directory. The second
one silently got the first one's branch handed back, reported as a success, so a
stack could not be built with `fw task add` at all:

```
order-type-filling/
  reflow-orders-use-order-type/          feature/orders-use-order-type
  reflow-orders-dual-write-order-type/   ⇡ stacked on it
  reflow-orders-backfill-order-type/     ⇡
  reflow-orders-drop-b2b-flag/           ⇡
```

The cost is a little redundancy on a single-branch task
(`ui-pr-links/fleetwood-ui-pr-links/`), and the gain is a name that never depends
on what was added first, never has to change when a second branch joins, and
always says which layer you are standing in. **Nothing is renamed**: a worktree
already in the task folder on the branch being asked for *is* the one, whatever it
is called, so folders built under the old rule keep working and top up in place.

`+ repo` takes that second word — `reflow feature/orders-dual-write-order-type` —
and so does `fw task add <slug> <repo> --branch <name>`. Left off, you get the
task's own branch, as before.

Since a repo can now appear more than once, the card counts both:
`1 repo · 4 worktrees`. And `off-branch` means what it says again — a stack layer's
directory is named for its branch, so it is where it claims to be; drift is a
worktree sitting on a branch nothing in its name accounts for.

```sh
fw task new fix flow "execution labels" --repo proto --repo graphy
fw task add flow-execution-labels api-scripts    # grow it as the work reveals itself
fw task add order-type-filling reflow --branch feature/orders-dual-write-order-type
fw task start flow-execution-labels              # a session for one that has none
fw task ls [--prs]                               # --prs also asks GitHub
fw task archive flow-execution-labels
```

The session's first window is rooted at the task folder, so **an agent there can grep
and edit across every involved repo** — that's what removes the upfront guessing.
⌘T opens it in the app, and so does ⌘K: the palette's last row is always **new
task**, carrying whatever you typed as the summary. That row is the answer to the
search that found nothing — you went looking for the work by name, and the reason
it wasn't there is that it doesn't exist yet.

**It asks one question at a time**, keyed the way `gum` keys a shell script: ↑↓
move, `↵` takes what you are on, `tab` builds a set out of several, `esc` steps
back. Repos first, then the type, the microservice, the summary, and a goal you
may skip. The answers stack up above the current question as lines you can click
to go back to, and the branch the whole convention is aimed at is shown from the
microservice onwards — as `feature/flow-…` while it is still a fragment, so a
half-built name cannot pass for a finished one.

Repos lead because that answer is what decides how much the rest of it matters: a
task is a folder of worktrees, and picking none of them is the one way to fill
every field in and have created nothing worth having. It is also the only question
here you answer by recognising something rather than composing it.

`↵` doing two jobs is what keeps `tab` from being a mode: it takes the set you
built if you built one, and the row you are standing on if you did not — so the
one-repo case, which is most of them, never has to find out the multi-select is
there. The five questions were five fields on one form before, which read as five
things to settle before anything would happen; they are one decision each, and
only the first is hard.

**Creating a task starts no agent.** Those are two decisions and only the first one
is being made at that moment — the repo set is still a guess, and a task often sits
for a while before anyone works it. So the session is made ready (right directory,
right branch, stamped as a task) and left at a shell. `+ claude` or `+ cursor` on the
card starts one at the task root; `--agent claude` does it at creation time if you
want the old behaviour.

**Tasks are not a separate list.** They were, and a live task was rendered twice for
it: once in the fleet as a plain session card — right agents, none of the repos, no
notes, a `kill` where `archive` belonged — and once in the tasks tab as a card that
knew the repos but nothing about what was running in them. They are the same tmux
session, so wanting to act on a task from the fleet was not a missing feature but
the same object split across two tabs. One list now; a task card *is* the session
card for a session with `@fw_task` stamped on it, and it carries both halves. The
join is that stamp, so nothing new is tracked to make it.

Since a task is also a folder that can exist with no session, the ones with none sit
under their own heading at the foot of the list, dashed rather than solid. Every
button on such a card makes the session first (`fw task start`, or `+ shell` to get
one without an agent) — before, a dormant task's card had no working control on it
at all. And because a four-repo task with notes is many times the height of a `HOME`
card, the repo rows collapse to `3 repos · 2 dirty` unless an agent is working inside
one or something is waiting on you; clicking the count pins it open either way.

Each repo row carries `+nvim`, which opens the editor in a fresh window of the
task's session, rooted at **that worktree** rather than at the task folder. It's a
window rather than a split because an editor wants the full height, and the command
is typed into a shell, so quitting it leaves you at a prompt in the right directory.
`editor` in the config names the command, and the button is labelled with it.

`notes` on the card writes `NOTES.md` beside the worktrees. It is a file of its own
because `task.json` is immutable and `TASK.md` is regenerated every time a repo is
added — notes typed into either would eventually be overwritten. Living beside the
worktrees rather than in `~/.fleetwood` also means an agent working the task can read
them without being told they exist, which is most of the point of writing them down;
`TASK.md` tells it to look. Emptying the box deletes the file, so "no notes" is one
state on disk rather than two.

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

**Each card carries the pull requests that task has open**, so the links stop being
something you keep by hand in `NOTES.md`. Nothing records what a task has pushed, so
the connection is rebuilt from git, and the obvious read — the branch each worktree
is on — is exactly the one that misses the case worth having: **stacked work**, where
one change becomes four branches and four PRs and only the tip is checked out
anywhere. So four sources are used per worktree, listed on the row in the order of
how strongly each claims the branch:

- the branch a worktree is **on**;
- branches that **contain** the task's branch — `⇡`. This is not a heuristic: a stack
  *is* a chain of branches each built on the one below, so containment is the
  definition. Only asked when the task's branch has commits of its own, because a
  branch still level with `dev` is contained by every branch in the repo;
- branches **checked out in that worktree** at some point, from its own reflog — `~`.
  Git keeps that log per worktree, which is the only reason it can answer "what was
  worked on *here*" rather than "in this repo". Catches a side branch cut straight
  from `dev` in the same directory, which containment cannot see;
- the task's **own branch** — `⇄` — whether or not anything is on it. The only one
  allowed to match a repo the folder doesn't hold, which is what surfaces a
  teammate's PR in a repo nobody has added yet.

Everything but the last is narrowed to branches holding commits the default branch
has not, which is what drops `dev`, `main` and every spent branch the reflog
remembers. That filter comes free: the same `for-each-ref` read gives each branch's
distance from the default, and **that distance is also its rung in a stack** — every
layer holds the one below it and then some — so the rows come out bottom-first
without anything having to be told what the stack is.

The whole fleet costs **one search**: GitHub ORs repeated `head:` qualifiers, so every
branch of every task goes into one query. What that search cannot return is a head
ref, so which branch a PR came from — and its checks and review state — is a
`gh pr view` each, cached against the PR's `updatedAt`, the one field that moves
when any of the rest does. A quiet fleet settles at a single `gh` call per poll. A
failed search keeps the last answer and marks it `stale` rather than emptying the
list, because a PR list that blanks on one flaky call reads as "you closed them".

`fw task ls --prs` prints the same thing; it is opt-in there because `task ls` is
otherwise all local git, and a network round trip is not what you want from the
command you run to remember a slug.

A task-root agent does **not** load each repo's `CLAUDE.md`/`AGENTS.md` or
`.claude/settings.local.json` at startup; `TASK.md` says so, and it picks them up
when it reads into a repo. Fresh worktrees have no `node_modules` (Go's module cache
is global, so Go builds work immediately).

## CLI

```
fw                    the fleet (default)
fw task ...           multi-repo tasks: new / add / start / ls / archive (see above)
fw watch              the fleet, refreshed live
fw agents             flat list, most urgent first
fw limits             plan quota: how much of each usage window is spent
fw prs                PRs awaiting your review, and your own
fw open-pr <ref>      focus a PR's session, or build one on a fresh worktree
fw approve [pane]     answer yes to a blocked agent
fw deny [pane]        answer no
fw kill-agent <pane|key>  close one agent, leaving its pane and session alone
fw focus <session>    point the terminal at a session
fw sessions | panes | repos | doctor | install-hooks
```

`fw open-pr` takes `owner/repo#123` or a full PR URL.

Output is painted in the configured `theme` (see **Themes**), and drops to plain text
under `NO_COLOR` or when piped.

## Layout

```
packages/core     tmux client, process scanner, event folding, github, worktrees, themes
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
out-of-order delivery), the screen parser (against real box-drawn prompts), the
kill-target precedence (each case has a plausible pid belonging to another agent),
the task view — which repo an agent is in, and what the collapsed repo line claims —
and the git/GitHub plumbing.
