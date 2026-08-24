---
name: relaunch-app
description: Rebuild Fleetwood.app from main and relaunch the installed macOS app. Use when asked to bundle, rebuild, reinstall, repackage or relaunch the app — "bundle and relaunch the app", "ship my changes to /Applications", "restart Fleetwood with the latest code".
---

# Bundle and relaunch Fleetwood

The app Kilian actually uses is `/Applications/Fleetwood.app`, installed from this
checkout. "Relaunch the app" means: get on `main`, rebuild the bundle, replace the
installed copy, start it again. Four commands.

## The main path

```bash
# 1. Be on main. There is no remote, so there is nothing to pull.
git switch main && git status --short

# 2. Quit the running app — step 3 deletes the bundle underneath it.
osascript -e 'quit app "Fleetwood"'

# 3. Build + sign + install (this runs `bundle`, which runs `build` and `icon`).
pnpm --filter @fleetwood/app install-app

# 4. Relaunch.
open -a /Applications/Fleetwood.app
```

A clean run of step 3 ends with:

```
Copying Electron from …/node_modules/.pnpm/electron@39.8.10/…/dist/Electron.app
Signing ad-hoc
Built …/packages/app/release/Fleetwood.app
installed /Applications/Fleetwood.app
```

Takes ~20s. Nothing prompts, nothing needs sudo.

## Which target am I rebuilding?

Check what's running before you pick a script — they are different apps:

```bash
ps ax -o pid,command | grep '[F]leetwood.app/Contents/MacOS'
```

| What you see | What's running | Use |
|---|---|---|
| `/Applications/Fleetwood.app/…/MacOS/Fleetwood` | the installed app | `install-app` (the main path) |
| `…/node_modules/…/Electron.app/…` or nothing | dev from the checkout | `pnpm --filter @fleetwood/app dev` |

| Script | Does |
|---|---|
| `build` | esbuild main + preload, vite renderer, copy hooks → `packages/app/dist/` |
| `bundle` | `build` + `icon` + assemble `packages/app/release/Fleetwood.app` |
| `install-app` | `bundle` + `rm -rf /Applications/Fleetwood.app` + copy it there |
| `dev` | `build` + `electron .` — no bundle, no install |

## Verify it landed

```bash
# Fresh timestamp on the code inside the installed bundle:
ls -ld /Applications/Fleetwood.app/Contents/Resources/app/dist/main/index.cjs

# A new main PID, plus helpers (GPU / network / renderer) means the window came up:
ps ax -o pid,command | grep '[F]leetwood.app' | wc -l   # 6 when healthy, 1 = renderer never started
```

The window may open behind your terminal — the tray title (`✋1`, `▶3`) and ⌥⇧F are
the real signs of life. Don't report success off `open` alone: it exits 0 for a
bundle that dies a second later.

## Gotchas

- **Quit before installing, not after.** `install-app` does `rm -rf
  /Applications/Fleetwood.app` before copying. Doing that under a live process
  yields a half-replaced bundle and a running app whose code is gone; macOS then
  refuses the relaunch on a signature mismatch. Quitting first costs ~20s of
  downtime and avoids the whole class of failure.
- **`osascript -e 'quit app "Fleetwood"'` prints nothing on success** — and also
  when no such app is running. Confirm with `ps -p <pid>` rather than trusting the
  silence.
- **This repo has no `origin` remote.** "Update on main" is `git switch main`, full
  stop; `git pull` fails and `git fetch` is a no-op. Feature branches live in
  worktrees (`.agents/worktrees/`, `.claude/worktrees/`) and land on local `main`,
  so `main` is normally already the newest thing. Verify with `git branch -vv`
  rather than assuming a branch has unmerged work.
- **Building from a worktree installs that worktree's code.** `install-app` uses
  the cwd, not the main checkout, and overwrites the one app in `/Applications`.
  Run it from `~/projects/fleetwood` unless you mean to install a branch.
- **The bundle is signed ad-hoc and never notarised.** Fine here — nothing
  downloads it, so Gatekeeper never quarantines it — but it will not launch on
  another Mac. Don't "fix" the signing step.
- **`release/` and `packages/app/build/` are gitignored.** The bundle and the
  generated `icon.icns` are build output; there is nothing to commit after a
  rebuild. If `git status` is dirty afterwards, you changed source, not artifacts.
- **A rebuild does not reinstall the agent hooks.** `dist/hooks/*.sh` ships inside
  the bundle, but `~/.claude/settings.json` still points wherever `fw
  install-hooks` last pointed it. Re-run that separately if hook behaviour
  changed — it is append-only and backs up to `~/.fleetwood/backups/`, and it must
  never disturb the existing peon-ping / herdr entries.
- **Electron is the fragile dependency, not the build.** `extract-zip` is broken on
  this machine, so `make-app.mjs` deliberately assembles the bundle from the
  already-extracted `Electron.app` in `node_modules` instead of using
  `@electron/packager`. Don't swap in a packager to "simplify" it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `dist/main/index.cjs missing — run pnpm build first` | `bundle` was skipped or `build` failed upstream; rerun `install-app` and read the esbuild/vite output. |
| `No usable Electron at …/dist/Electron.app` | `extract-zip` failed again. Extract by hand — see "Two macOS packaging traps" in `README.md`. |
| App bounces in the Dock and dies | Stale/broken signature from installing over a live app. Quit, rerun `install-app`, relaunch. |
| Empty fleet, no sessions | GUI launch has almost no `PATH`, so `tmux`/`gh` are invisible. `main/path.ts` repairs it — suspect a regression there, not tmux. |
| Renderer shows the old UI | Vite output cached in the previous bundle; confirm the `index-*.js` hash under `/Applications/Fleetwood.app/Contents/Resources/app/dist/renderer/assets/` changed. |
| `codesign` verify fails | Something is writing into the bundle mid-build (Spotlight, a running instance). Quit the app, `rm -rf packages/app/release`, rerun. |
