import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, shell, Tray } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  actions,
  buildFleet,
  config as configModule,
  github,
  hooks,
  limits as limitsApi,
  paths,
  deployMarks,
  prSession,
  repoIndex,
  spool,
  task as taskApi,
  THEMES,
} from '@fleetwood/core';
import type { MergedPr, MergedPrs, PlanLimits, PrLists, Task } from '@fleetwood/core';
import { repairPath } from './path.ts';
import { CHANNELS } from '../shared/ipc.ts';
import type { Request, Response, Snapshot } from '../shared/ipc.ts';

/**
 * This file is bundled to CJS for Electron's main process, where `__dirname` is
 * the real thing and `import.meta` is stubbed out to `{}` by esbuild.
 */
const BUNDLE_DIR = __dirname;

/**
 * Core cannot find the hook scripts by module path once bundled, so point it at
 * the copy the build places beside the bundle.
 */
process.env.FLEETWOOD_HOOKS_DIR ??= join(BUNDLE_DIR, '..', 'hooks');

const WINDOW_STATE = join(paths.FW_HOME, 'window.json');

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let collector: Awaited<ReturnType<typeof spool.Collector.start>> | undefined;
let prs: PrLists | undefined;
let merged: MergedPrs | undefined;
/**
 * Merged PRs whose state nothing can change any more, so they are never
 * re-queried. Without this the section would cost three `gh` processes per PR on
 * every poll, forever; with it, steady state is one search call.
 */
let mergedCache = new Map<string, MergedPr>();
/** `prKey → epoch seconds` for merges the user says they deployed by hand. */
let deployedByHand = new Map<string, number>();
/** Cached: listing tasks runs a `git status` per repo, too costly for the 1s poll. */
let taskCache: { at: number; tasks: Task[] } = { at: 0, tasks: [] };
/**
 * Plan quota, on its own slow clock.
 *
 * Kept across failures and flagged `stale` rather than dropped: a five-hour
 * window barely moves, so yesterday's bar still says roughly where you stand,
 * and a bar that vanishes on one flaky request is worse than a dated one.
 */
let planLimits: PlanLimits | undefined;
let limitsAt = 0;
let fleetTimer: NodeJS.Timeout | undefined;
let prTimer: NodeJS.Timeout | undefined;
let mergedTimer: NodeJS.Timeout | undefined;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
}

const DEFAULT_WINDOW: WindowState = { width: 460, height: 900, alwaysOnTop: false };

async function loadWindowState(): Promise<WindowState> {
  try {
    return { ...DEFAULT_WINDOW, ...(JSON.parse(await readFile(WINDOW_STATE, 'utf8')) as WindowState) };
  } catch {
    return DEFAULT_WINDOW;
  }
}

async function saveWindowState(): Promise<void> {
  if (!win) return;
  const bounds = win.getBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop: win.isAlwaysOnTop(),
  };
  try {
    await paths.ensureDirs();
    await writeFile(WINDOW_STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Losing window position is not worth surfacing.
  }
}

const TASK_TTL_MS = 5_000;

async function getTasks(force = false): Promise<Task[]> {
  const now = Date.now();
  if (!force && now - taskCache.at < TASK_TTL_MS) return taskCache.tasks;
  taskCache = { at: now, tasks: await taskApi.listTasks() };
  return taskCache.tasks;
}

async function refreshLimits(settings: Awaited<ReturnType<typeof configModule.loadConfig>>): Promise<void> {
  if (!settings.limits.tokenCommand.trim()) {
    planLimits = undefined;
    return;
  }
  const now = Date.now();
  if (now - limitsAt < settings.limits.pollSeconds * 1_000) return;
  limitsAt = now;
  const fetched = await limitsApi.fetchLimits({ tokenCommand: settings.limits.tokenCommand });
  if (fetched) planLimits = fetched;
  else if (planLimits) planLimits = { ...planLimits, stale: true };
}

async function buildSnapshot(): Promise<Snapshot> {
  const settings = await configModule.loadConfig();
  await refreshLimits(settings);
  const fleet = await buildFleet({
    states: collector?.states,
    capture: settings.capture,
    // Cheap on the 1s poll: each transcript is re-read only from the byte where
    // the last read stopped.
    usage: true,
  });

  // Which PR each session is working on, so the PR list can say "already open".
  const prSessions: Record<string, string> = {};
  for (const session of fleet.sessions) {
    if (session.meta.pr) prSessions[session.meta.pr] = session.name;
  }

  const hookState = await hooks.hookStatus();
  return {
    fleet,
    tasks: await getTasks(),
    prs,
    merged,
    prSessions,
    hooksInstalled: hookState.claude.installed > 0,
    editor: settings.editor,
    theme: settings.theme,
    bgOpacity: settings.bgOpacity,
    limits: planLimits,
  };
}

function summarise(snapshot: Snapshot): string {
  const { counts } = snapshot.fleet;
  const blocked = counts.blocked_permission + counts.blocked_input;
  if (blocked > 0) return `✋${blocked}`;
  if (counts.working > 0) return `▶${counts.working}`;
  if (counts.total > 0) return `○${counts.total}`;
  return '—';
}

async function pushSnapshot(): Promise<void> {
  const snapshot = await buildSnapshot();
  win?.webContents.send(CHANNELS.snapshot, snapshot);
  tray?.setTitle(summarise(snapshot));
}

async function refreshPrs(): Promise<void> {
  const settings = await configModule.loadConfig();
  if (!settings.github.enabled) return;
  prs = await github.fetchPrs();
  await pushSnapshot();
}

/**
 * The recently-merged list, ordered and stamped with your own deploy marks.
 *
 * `force` is the hard refresh: it drops the cache so even a row that reads
 * `deployed` or `built` is asked again. That matters because those states are
 * terminal by assumption, and the assumption is occasionally wrong — a re-run
 * workflow, or a pattern you just corrected in the config.
 */
async function refreshMerged(force = false): Promise<void> {
  const settings = await configModule.loadConfig();
  if (!settings.github.enabled || !settings.github.merged.enabled) {
    merged = undefined;
    return;
  }
  if (force) mergedCache = new Map();

  const { lookbackHours } = settings.github.merged;
  // Twice the window: a mark only matters while its PR could still be listed, and
  // the slack keeps a widened lookback from dropping marks it should still honour.
  const cutoff = Math.floor(Date.now() / 1000) - lookbackHours * 3_600 * 2;
  deployedByHand = await deployMarks.loadMarks(cutoff);

  merged = await github.fetchMergedPrs({
    config: settings.github.merged,
    cached: mergedCache,
    marks: deployedByHand,
  });

  const next = new Map<string, MergedPr>();
  for (const pr of merged.prs) next.set(github.prKey(pr.repo, pr.number), pr);
  mergedCache = next;
  await pushSnapshot();
}

/**
 * Apply a hand-mark to what the renderer is already showing.
 *
 * Re-running the whole fan-out would be several seconds of `gh` for a fact we
 * already hold, and the row has to move the moment it is clicked.
 */
function restampMarks(): void {
  if (!merged) return;
  const prs = merged.prs
    .map((pr) => {
      const at = deployedByHand.get(github.prKey(pr.repo, pr.number));
      const { deployedByHand: _drop, ...rest } = pr;
      return at === undefined ? (rest as MergedPr) : { ...rest, deployedByHand: at };
    })
    .sort((a, b) => {
      const done = Number(github.isDone(a)) - Number(github.isDone(b));
      return done !== 0 ? done : b.mergedAt.localeCompare(a.mergedAt);
    });
  merged = { ...merged, prs };
  for (const pr of prs) mergedCache.set(github.prKey(pr.repo, pr.number), pr);
}

/**
 * Close a single agent, named by its fleet key.
 *
 * The key, not the pid: the renderer's snapshot can be a second old, and a stale
 * pid is the one input this action must not take — by the time a click arrives
 * that number may belong to something else entirely. So the key is resolved
 * against a fresh read here, which also means the button is a no-op on an agent
 * that has already exited.
 */
async function killAgent(key: string): Promise<Response> {
  // No `capture`: this needs pids, not pane contents.
  const fleet = await buildFleet({ states: collector?.states });
  const agent = [...fleet.sessions.flatMap((s) => s.agents), ...fleet.orphans].find(
    (a) => a.key === key,
  );
  if (!agent) return { ok: false, detail: 'that agent is no longer listed' };

  const result = await actions.killAgent(agent);
  // We are the collector, so we own the state file: record the death ourselves,
  // since the agent cannot report it.
  if (result.ok && collector && spool.markGone(collector.states, key)) {
    await spool.saveState(collector.states);
  }
  return result;
}

async function handle(request: Request): Promise<Response> {
  switch (request.kind) {
    case 'refresh':
      await collector?.drain();
      await pushSnapshot();
      return { ok: true, detail: 'refreshed' };

    case 'refreshPrs':
      await refreshPrs();
      return { ok: true, detail: 'pull requests refreshed' };

    case 'refreshMerged':
      await refreshMerged(request.force ?? false);
      return { ok: true, detail: request.force ? 'merged list re-read from scratch' : 'merged list refreshed' };

    case 'markPrDeployed': {
      const at = Math.floor(Date.now() / 1000);
      await deployMarks.markDeployed(request.key, at);
      deployedByHand.set(request.key, at);
      restampMarks();
      await pushSnapshot();
      return { ok: true, detail: `${request.key} marked deployed` };
    }

    case 'unmarkPrDeployed': {
      await deployMarks.unmarkDeployed(request.key);
      deployedByHand.delete(request.key);
      restampMarks();
      await pushSnapshot();
      return { ok: true, detail: `${request.key} is unshipped again` };
    }

    case 'focusSession':
      return actions.focusSession(request.session);

    case 'focusPane':
      return actions.focusPane(request.pane);

    case 'killSession': {
      const result = await actions.killSession(request.session);
      await pushSnapshot();
      return result;
    }

    case 'killAgent': {
      const result = await killAgent(request.key);
      await pushSnapshot();
      return result;
    }

    case 'archiveSession': {
      const result = await prSession.archivePrSession(request.session, request.force ?? false);
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'openPr': {
      const result = await prSession.openPr({
        repo: request.repo,
        number: request.number,
        branch: request.branch,
        title: '',
        url: '',
        updatedAt: '',
        isDraft: false,
        roles: [],
      });
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'answerPrompt': {
      const result = await actions.answerPrompt(request.pane, request.key);
      // The agent moves on immediately; re-read so the UI doesn't lag behind.
      setTimeout(() => void pushSnapshot(), 400);
      return result;
    }

    case 'interrupt':
      return actions.interruptAgent(request.pane);

    case 'sendPrompt':
      return actions.sendPrompt(request.pane, request.text);

    case 'spawnAgent': {
      const result = await actions.spawnAgent({
        session: request.session,
        cwd: request.cwd,
        tool: request.tool,
      });
      await pushSnapshot();
      return result;
    }

    case 'openProject': {
      const result = await actions.openProject({ path: request.path });
      await pushSnapshot();
      return result;
    }

    case 'listProjects': {
      const index = await repoIndex.getIndex();
      return {
        ok: true,
        detail: `${index.repos.length} projects`,
        projects: index.repos.map((r) => ({
          path: r.path,
          name: r.path.split('/').pop() ?? r.path,
          repo: r.nameWithOwner,
          isRepo: r.isRepo,
        })),
      };
    }

    case 'listTasks':
      return { ok: true, detail: 'tasks', tasks: await getTasks(true) };

    case 'createTask': {
      const result = await taskApi.createTask({
        type: request.type,
        microservice: request.microservice,
        summary: request.summary,
        goal: request.goal,
        repos: request.repos,
        branchOverrides: request.branchOverrides,
        // Undefined means none: core decides, so the two front ends can't drift.
        agent: request.agent,
      });
      await getTasks(true);
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'startTaskSession': {
      const result = await taskApi.startTaskSession(request.slug, request.agent ?? 'none');
      // Force: the card's every other button needs the session name, and the task
      // cache is up to 5s old.
      await getTasks(true);
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'addRepoToTask': {
      const result = await taskApi.addRepoToTask(request.slug, request.repo, request.branch);
      await getTasks(true);
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'setTaskNotes': {
      const result = await taskApi.writeTaskNotes(request.slug, request.notes);
      // Force: the task cache is 5s old and the textarea has to settle at once.
      await getTasks(true);
      await pushSnapshot();
      return result;
    }

    case 'openEditor': {
      const settings = await configModule.loadConfig();
      const result = await actions.openEditor({
        session: request.session,
        cwd: request.cwd,
        editor: settings.editor,
        name: request.name,
      });
      await pushSnapshot();
      return result;
    }

    case 'archiveTask': {
      const result = await taskApi.archiveTask(request.slug, request.force ?? false);
      await getTasks(true);
      await pushSnapshot();
      return { ok: result.ok, detail: result.detail };
    }

    case 'openExternal':
      await shell.openExternal(request.url);
      return { ok: true, detail: 'opened in browser' };

    case 'installHooks': {
      const report = await hooks.installAll();
      await pushSnapshot();
      return {
        ok: true,
        detail: `claude: +${report.claude.added.length}, cursor: +${report.cursor.added.length}`,
      };
    }

    case 'setTheme': {
      // Only this key is written, so a hand-written config keeps its shape and
      // its comments-by-omission. The push is what actually repaints.
      await configModule.saveTheme(request.theme);
      await pushSnapshot();
      const theme = THEMES[request.theme];
      return { ok: true, detail: `${theme.family} ${theme.label}` };
    }

    case 'setBgOpacity': {
      // The renderer has already repainted; this only records it. Dragging the
      // slider is debounced there, so this is one write per adjustment, not one
      // per pixel.
      await configModule.saveBgOpacity(request.value);
      await pushSnapshot();
      return { ok: true, detail: `background ${Math.round(request.value * 100)}%` };
    }

    case 'setAlwaysOnTop':
      win?.setAlwaysOnTop(request.value);
      await saveWindowState();
      return { ok: true, detail: request.value ? 'pinned on top' : 'unpinned' };
  }
}

async function createWindow(): Promise<void> {
  const state = await loadWindowState();

  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 380,
    show: false,
    // A side panel, not a document window.
    titleBarStyle: 'hiddenInset',
    /*
     * Transparent always, whatever `bgOpacity` says, because Electron fixes
     * transparency at creation: a window born opaque can never be seen through,
     * and a slider that needed a relaunch to take effect is not a slider. So the
     * window contributes no fill of its own and every pixel of background comes
     * from the renderer's `--bg` / `--panel`, which carry the alpha. At the
     * default opacity of 1 those are solid and this looks exactly as it did.
     *
     * The cost is the native drop shadow, which macOS does not draw on a
     * transparent window — hence the CSS ring on `.app` standing in for it.
     */
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: state.alwaysOnTop,
    webPreferences: {
      preload: join(BUNDLE_DIR, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(join(BUNDLE_DIR, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  win.on('moved', () => void saveWindowState());
  win.on('resized', () => void saveWindowState());
  win.on('closed', () => {
    win = undefined;
  });
}

function toggleWindow(): void {
  if (!win) {
    void createWindow();
    return;
  }
  if (win.isVisible() && win.isFocused()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

app.whenReady().then(async () => {
  // Before any tmux/git/gh call: a GUI launch has none of them on PATH.
  await repairPath();
  await paths.ensureDirs();

  // The collector keeps folding hook events whether or not the window is open.
  collector = await spool.Collector.start({ onUpdate: () => void pushSnapshot() });

  const settings = await configModule.loadConfig();

  await createWindow();

  // An empty image plus a title renders as text in the macOS menu bar, which is
  // all we need — the count is the point, not an icon.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('fleetwood');
  tray.on('click', toggleWindow);

  ipcMain.handle(CHANNELS.invoke, async (_event, request: Request) => {
    try {
      return await handle(request);
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  });

  fleetTimer = setInterval(() => void pushSnapshot(), settings.poll.tmuxMs);
  prTimer = setInterval(() => void refreshPrs(), settings.github.pollSeconds * 1_000);
  // Its own, slower clock: a merge's CI trail takes minutes, and each new row
  // costs a `gh pr view` plus a `gh run list`.
  mergedTimer = setInterval(
    () => void refreshMerged(),
    settings.github.merged.pollSeconds * 1_000,
  );
  await pushSnapshot();
  void refreshPrs();
  void refreshMerged();

  globalShortcut.register('Alt+Shift+F', toggleWindow);

  app.on('activate', () => {
    if (!win) void createWindow();
    else win.show();
  });
});

app.on('window-all-closed', () => {
  // Stay resident: the tray count is useful with no window open.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  collector?.stop();
  if (fleetTimer) clearInterval(fleetTimer);
  if (prTimer) clearInterval(prTimer);
  if (mergedTimer) clearInterval(mergedTimer);
});
