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
  prSession,
  repoIndex,
  spool,
  task as taskApi,
} from '@fleetwood/core';
import type { PlanLimits, PrLists, Task } from '@fleetwood/core';
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
    prSessions,
    hooksInstalled: hookState.claude.installed > 0,
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
        agent: request.agent ?? 'claude',
      });
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
    backgroundColor: '#191724',
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
  await pushSnapshot();
  void refreshPrs();

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
});
