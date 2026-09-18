import { app, BrowserWindow, screen } from 'electron';
import {
  DEFAULT_SHUTDOWN,
  config as configModule,
  hasMissed,
  nextShutdownAt,
  run,
  shutdownState,
  sudoReachedShutdown,
} from '@fleetwood/core';
import type { ShutdownConfig, ShutdownState } from '@fleetwood/core';

/**
 * The end-of-day shutdown, from the panel's side: arming it, putting the warning
 * on the screen, and turning the machine off.
 *
 * The clock arithmetic is not here — it is in `core/shutdown.ts`, which is pure
 * and tested. What is here is the part that touches the world, and it is kept in
 * one file because every piece of it is irreversible: this is the only module in
 * fleetwood that can cost you unsaved work.
 *
 * It runs on its own timer rather than off the snapshot poll. The panel can be
 * closed all evening — the window is a side panel you hide with a hotkey — and a
 * shutdown that only happened while you were looking at it would be worse than
 * no shutdown at all.
 */

/**
 * Coarse on purpose.
 *
 * The overlay's countdown is drawn in the renderer from the armed timestamp
 * against its own clock, so nothing anyone looks at ticks on this interval. All
 * it decides is how late the shutdown can be, and five seconds of slack on "when
 * do I stop working" is not a fact worth a wakeup a second for.
 */
const TICK_MS = 5_000;

/**
 * `shutdown` is the command, `sudo -n` is the promise never to prompt.
 *
 * Non-interactive without exception: there is no terminal attached to a GUI app,
 * so a sudo that decided to ask for a password would hang forever holding a
 * shutdown nobody can see. It fails loudly instead, and the power tab says so
 * before the evening rather than at the end of it — see `probePermitted`.
 */
const SUDO_SHUTDOWN = ['-n', '/sbin/shutdown', '-h', 'now'];

/**
 * The same binary with nothing to do: the permission check.
 *
 * `shutdown` needs a time and prints its usage without one, so this changes
 * nothing about the machine — but sudo has already decided by the time it runs,
 * and that decision is the whole question. See `probePermitted`.
 */
const SUDO_PROBE = ['-n', '/sbin/shutdown'];

interface Options {
  /** `index.html` in the built renderer — the overlay is the same bundle. */
  rendererIndex: string;
  preload: string;
  /** Push a snapshot: the schedule just moved and both windows draw it. */
  onChange: () => void;
}

export interface ShutdownScheduler {
  /** The schedule as it stands, for the snapshot. Synchronous: it is all in hand. */
  state: (now?: number) => ShutdownState;
  /** Write a new schedule, re-arm from it, and hand back what it became. */
  set: (next: ShutdownConfig) => Promise<ShutdownState>;
  /** Take the warning off the screen. The shutdown still happens. */
  dismiss: () => void;
  stop: () => void;
}

export function startShutdown({ rendererIndex, preload, onChange }: Options): ShutdownScheduler {
  /** The last config read off disk. The scheduler owns it; the snapshot reads it. */
  let config: ShutdownConfig = DEFAULT_SHUTDOWN;
  /**
   * The timestamp this is armed for.
   *
   * Held rather than recomputed each tick, and that is the whole reason it
   * exists: `nextShutdownAt` answers strictly in the future, so the moment the
   * clock passes 19:00 it starts saying tomorrow — and a scheduler that asked it
   * every tick would arm past its own shutdown instead of firing it.
   */
  let armedAt: number | undefined;
  /** What the time was when we armed, so a change to it re-arms and nothing else does. */
  let armedFor = '';
  let permitted: boolean | undefined;
  let lastError: string | undefined;
  /** The shutdown command is out. Nothing may fire a second one behind it. */
  let firing = false;
  let overlay: BrowserWindow | undefined;
  /**
   * The armed shutdown whose warning has been read and waved away.
   *
   * Keyed on the timestamp rather than a bare boolean, so it means "I have seen
   * *this* one": re-arming for tomorrow clears it on its own, and nothing can
   * dismiss a warning that has not been shown yet.
   */
  let dismissedFor: number | undefined;

  /**
   * Whether `sudo` will run the shutdown without asking for a password.
   *
   * Probed rather than assumed because the answer needs a line in
   * `/etc/sudoers.d` that fleetwood cannot write for you, and a schedule that
   * silently cannot fire is the one failure this feature must not have.
   *
   * Asked by doing the harmless half rather than with `sudo -l`, which was the
   * first attempt and was wrong on every machine: listing your own privileges
   * needs a password of its own on a stock macOS — `listpw` defaults to `any`,
   * and the admin group's ordinary `ALL=(ALL) ALL` is an entry that requires
   * one — so it reported "no" for correctly configured machines too.
   *
   * So: run `shutdown` with no arguments. It needs a time, prints its usage
   * without one, and changes nothing either way; sudo has already decided by
   * then. This is also why the documented sudoers rule names no arguments —
   * the exact-argument form cannot be verified without shutting the machine
   * down to find out.
   */
  async function probePermitted(): Promise<void> {
    const { stdout, stderr } = await run('sudo', SUDO_PROBE, { timeoutMs: 5_000 });
    permitted = sudoReachedShutdown(`${stdout}${stderr}`);
  }

  function openOverlay(): void {
    if (overlay) return;
    // The display the menu bar is on: this is a "look up from what you are doing"
    // notice, and on a second screen it would be behind the thing you are doing.
    const { bounds } = screen.getPrimaryDisplay();
    overlay = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
    });
    /*
     * It takes the screen, and it takes focus.
     *
     * The point of the warning is that the day is ending and you have to notice,
     * so it stops what you are doing rather than tinting it — and then it lets
     * you go: one key, one button, and the machine still goes down at the hour.
     * Dismissing is "I know", not "not tonight"; opting out is the power tab.
     */
    // `screen-saver` is the level above a fullscreen app: an editor in fullscreen
    // is exactly the state in which you would miss this.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.on('closed', () => {
      overlay = undefined;
    });
    // The same bundle, told which of the two screens it is. See `main.tsx`.
    void overlay.loadFile(rendererIndex, { hash: 'shutdown-warning' });
    // In front of whatever had focus, or the one key that dismisses it would go
    // to the editor underneath instead.
    overlay.once('ready-to-show', () => overlay?.focus());
  }

  function closeOverlay(): void {
    overlay?.close();
    overlay = undefined;
  }

  /**
   * Turn the machine off, and close the app behind it.
   *
   * `app.quit()` regardless of what sudo said: on the way down it is redundant —
   * macOS is already tearing processes out — and on a refusal it would be wrong,
   * so it only runs on success. A refusal re-arms for tomorrow and leaves the
   * reason on the power tab, because the alternative is an overlay stuck on the
   * screen over a machine that is plainly still on.
   */
  async function fire(): Promise<void> {
    firing = true;
    const { code, stderr } = await run('sudo', SUDO_SHUTDOWN, { timeoutMs: 30_000 });
    if (code === 0) {
      lastError = undefined;
      app.quit();
      return;
    }
    permitted = false;
    lastError = stderr.trim() || `sudo shutdown exited ${code}`;
    firing = false;
    closeOverlay();
    armedAt = nextShutdownAt(config.time, Date.now());
    onChange();
  }

  async function tick(): Promise<void> {
    const settings = await configModule.loadConfig();
    config = settings.shutdown;
    const now = Date.now();

    if (!config.enabled) {
      const wasArmed = armedAt !== undefined;
      armedAt = undefined;
      armedFor = '';
      closeOverlay();
      if (wasArmed) onChange();
      return;
    }

    // Re-armed only when there is nothing armed, or when the time itself moved.
    // Not every tick: see `armedAt`.
    if (armedAt === undefined || armedFor !== config.time) {
      armedAt = nextShutdownAt(config.time, now);
      armedFor = config.time;
      // A new shutdown is a new warning: yesterday's "I know" does not cover it.
      dismissedFor = undefined;
      onChange();
    }
    if (armedAt === undefined) return;

    /*
     * Slept through it — see `hasMissed`. Re-armed for the next one rather than
     * fired: every timer in the process goes off at once when the lid opens, and
     * this is the only one that would take the machine with it.
     */
    if (hasMissed(armedAt, now)) {
      armedAt = nextShutdownAt(config.time, now);
      dismissedFor = undefined;
      closeOverlay();
      onChange();
      return;
    }

    if (now >= armedAt) {
      if (!firing) void fire();
      return;
    }

    if (armedAt - now <= config.warnMinutes * 60_000) {
      if (dismissedFor !== armedAt) openOverlay();
    } else closeOverlay();
  }

  function state(now = Date.now()): ShutdownState {
    return shutdownState({ config, at: armedAt, now, permitted, error: lastError });
  }

  /**
   * "I know" — the warning comes off the screen and the shutdown stands.
   *
   * Recorded against the armed timestamp rather than just closing the window,
   * because the tick five seconds later would otherwise put it straight back up.
   */
  function dismiss(): void {
    dismissedFor = armedAt;
    closeOverlay();
  }

  async function set(next: ShutdownConfig): Promise<ShutdownState> {
    await configModule.saveShutdown(next);
    // Straight to the clock rather than waiting out the tick: the tab you just
    // typed a time into has to agree with you at once.
    await tick();
    // The sudoers rule may have been added since the last probe, and this is the
    // click that would have been made right after adding it.
    if (permitted !== true) await probePermitted();
    return state();
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  void probePermitted();
  void tick();

  return {
    state,
    set,
    dismiss,
    stop(): void {
      clearInterval(timer);
      closeOverlay();
    },
  };
}
