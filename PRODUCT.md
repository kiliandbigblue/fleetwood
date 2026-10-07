# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One user: Kilian, a senior engineer at Bigblue who runs several coding agents at once in tmux, each task in its own folder of git worktrees. He lives in nvim and tmux, in Fira Code, on Rosé Pine (or another of fleetwood's dark themes). He reviews two kinds of change: what his own agents produced in a task worktree, and teammates' pull requests that ask for his review.

## Product Purpose
Fleetwood is a tmux-native cockpit for coordinating coding agents: an Electron panel and the `fw` CLI over tasks, sessions, worktrees and pull requests. The review page is where a change gets read. An agent cuts the diff into sections that follow the change's logic (contracts, then wiring, then core logic), and the page shows one section at a time, each change inside its enclosing function. Success: he can review a change top to bottom without jumping between files, get interrupted, and pick up exactly where he left off.

## Positioning
Unlike file-by-file diff viewers (GitHub, difit), the reading order is the change's logic, not the file tree, and every changed line is still guaranteed to be shown exactly once. The recap presents and never judges: no risk badges, no guessed intent.

## Operating Context
- Opened from a repo row's `review` button in the fleetwood panel, in a large browser window; the terminal sits elsewhere.
- Reviews are often interrupted; checkoffs per section are how he resumes.
- Comments are a Question (answered inline by an agent, neutrally) or a Concern (sent to the task's Claude pane, or to the clipboard for a teammate's PR).
- Keyboard-first: j/k, n/p, x, c.

## Capabilities and Constraints
- Single HTML page, inline CSS and vanilla JS, served by fleetwood's main process (`packages/core/src/tourPage.ts`); no build step, no external network.
- Coloured only through fleetwood's eleven palette roles (bg, panel, edge, dim, soft, text, danger, warn, ok, accent, branch); every theme is dark.
- A recap takes one to three minutes to build; the page must show that state honestly.
- States: building, error (with rerun), ready, stale (worktree moved; offer a fresh review).

## Brand Commitments
- Lives inside fleetwood's visual world: Fira Code, the palette roles, the panel's quiet register.
- The diff must be elegant, at least as refined as difit's rendering, but must not look like GitHub or difit's grey file-by-file chrome.

## Product Principles
- The code leads; chrome recedes.
- Never lose the reader's place: where am I, what's left, what did I already see.
- Present, don't judge.
- Every changed line is accounted for.
