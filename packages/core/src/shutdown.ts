/**
 * The end-of-day shutdown: when the machine goes down, and how close that is.
 *
 * A leaf with no `fs` and no `child_process`, for the same reason `theme.ts` is
 * one: the renderer draws the countdown and must not pull tmux and process
 * scanning into its bundle to get it. It also makes the one genuinely awkward
 * question here — what `19:00` means at 18:40, and what it means at 19:01 —
 * something a test can ask rather than something the scheduler decides in
 * passing.
 *
 * Deliberately not a cron expression. This is "when do I stop working", which is
 * one time of day, and a field you can read off the panel at a glance is worth
 * more than every schedule it cannot express.
 */

export interface ShutdownConfig {
  /**
   * Opted in.
   *
   * Off by default, and the only reason this key is a boolean rather than the
   * time being empty: turning your machine off is not something fleetwood may
   * start doing because a default changed under it, so the opt-in is its own
   * fact and survives you editing the time.
   */
  enabled: boolean;
  /** A wall clock, `HH:MM` on a 24h clock, in the machine's own timezone. */
  time: string;
  /** How long the warning stands before the machine goes down. */
  warnMinutes: number;
}

export const DEFAULT_SHUTDOWN: ShutdownConfig = {
  enabled: false,
  time: '19:00',
  warnMinutes: 15,
};

/**
 * The warning's bounds.
 *
 * A floor of one minute because a warning shorter than the time it takes to read
 * it is not a warning; a ceiling of two hours because past that the overlay is no
 * longer telling you about the end of the day, it is the day.
 */
export const MIN_WARN_MINUTES = 1;
export const MAX_WARN_MINUTES = 120;

export interface Clock {
  hour: number;
  minute: number;
}

/** `HH:MM` on a 24h clock, or nothing — an unreadable time schedules nothing. */
export function parseClock(text: string): Clock | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/** Zero-padded, which is the only form `<input type="time">` accepts back. */
export function formatClock({ hour, minute }: Clock): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function clampWarnMinutes(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SHUTDOWN.warnMinutes;
  return Math.min(MAX_WARN_MINUTES, Math.max(MIN_WARN_MINUTES, Math.round(value as number)));
}

/**
 * A config that cannot express a shutdown nobody asked for.
 *
 * Applied on read rather than on write, like the theme: the file is meant to be
 * editable by hand, and a typo in the time must leave the schedule off rather
 * than firing at an hour nobody chose.
 */
export function normaliseShutdown(raw: Partial<ShutdownConfig> | undefined): ShutdownConfig {
  const written = typeof raw?.time === 'string' ? raw.time.trim() : '';
  const readable = parseClock(written) !== undefined;
  return {
    // Opted in *and* legible. An unreadable time falls back to the default hour
    // below so the field has something in it — but falling back is not consent
    // to shut the machine down at an hour nobody wrote, so it also turns off.
    enabled: raw?.enabled === true && readable,
    time: readable ? written : DEFAULT_SHUTDOWN.time,
    warnMinutes: clampWarnMinutes(raw?.warnMinutes),
  };
}

/**
 * The next moment the local clock reads `time`, strictly after `now`.
 *
 * Strictly: at 19:00:00 exactly this answers tomorrow, which is what makes it
 * safe to call every tick without it re-arming the shutdown that is currently
 * firing. The scheduler holds the armed timestamp it got and stops asking.
 *
 * Built from local calendar fields rather than by adding 86_400_000, so the two
 * days a year that are not 24 hours long still shut down at the time on the
 * clock rather than an hour either side of it.
 */
export function nextShutdownAt(time: string, now: number): number | undefined {
  const clock = parseClock(time);
  if (!clock) return undefined;
  const at = new Date(now);
  at.setHours(clock.hour, clock.minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/**
 * Where the schedule stands.
 *
 * `off` — opted out, or the time is unreadable.
 * `armed` — a shutdown is set and is further off than the warning.
 * `warning` — inside the warning window; the overlay is up.
 * `due` — the time has come and the machine has not gone down yet.
 */
export type ShutdownPhase = 'off' | 'armed' | 'warning' | 'due';

/**
 * How late a shutdown may be and still be worth firing.
 *
 * This exists for the lid: the machine was asleep at 19:00 and it is now 08:12
 * on Tuesday, and every timer in the process fires at once the moment it wakes.
 * A shutdown that went off then would take the morning down with no warning at
 * all — so a missed one is missed, and the schedule is re-armed for tonight.
 *
 * Five minutes, because the only thing that should get through it is the app
 * itself being busy at 19:00:00, never a night of sleep.
 */
export const MISSED_GRACE_MS = 5 * 60_000;

/** Whether the armed shutdown was slept through rather than reached. */
export function hasMissed(at: number, now: number): boolean {
  return now - at > MISSED_GRACE_MS;
}

export function shutdownPhase(at: number | undefined, warnMinutes: number, now: number): ShutdownPhase {
  if (at === undefined) return 'off';
  if (now >= at) return 'due';
  return at - now <= clampWarnMinutes(warnMinutes) * 60_000 ? 'warning' : 'armed';
}

/** What the renderer is told about the schedule — the whole of it. */
export interface ShutdownState extends ShutdownConfig {
  /** Epoch ms the machine goes down at. Absent while opted out. */
  at?: number;
  phase: ShutdownPhase;
  /** Milliseconds until `at`, floored at zero so the overlay never counts up. */
  msLeft?: number;
  /**
   * Whether `sudo` will run the shutdown without asking for a password.
   *
   * Undefined until it has been probed. Surfaced rather than kept in main
   * because a schedule that cannot fire is worth saying so on the tab you set it
   * on, not at 19:00 when it does nothing.
   */
  permitted?: boolean;
  /** What went wrong the last time it tried, if it has tried and failed. */
  error?: string;
}

interface StateInput {
  config: ShutdownConfig;
  /** The timestamp the scheduler armed, so a `due` shutdown is not re-armed away. */
  at: number | undefined;
  now: number;
  permitted?: boolean;
  error?: string;
}

export function shutdownState({ config, at, now, permitted, error }: StateInput): ShutdownState {
  const armed = config.enabled ? at : undefined;
  return {
    ...config,
    at: armed,
    phase: shutdownPhase(armed, config.warnMinutes, now),
    msLeft: armed === undefined ? undefined : Math.max(0, armed - now),
    permitted,
    error,
  };
}

/**
 * The countdown, as the overlay says it.
 *
 * `mm:ss` under the hour and `h:mm:ss` over it — a clock rather than the fleet's
 * `3h12m` durations, because this one is being watched rather than glanced at,
 * and a number that visibly moves every second is the whole point of putting it
 * on the screen.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/**
 * Whether two timestamps fall on the same local day.
 *
 * Local calendar fields rather than a division: a shutdown 20 minutes away can
 * still be tomorrow, and 20 minutes before midnight is exactly when the tab has
 * to say so.
 */
function sameDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** When the machine goes down, in the panel's own voice. */
export function describeShutdown(state: ShutdownState, now: number): string {
  if (state.at === undefined) return 'nothing scheduled';
  if (state.phase === 'due') return 'shutting down';
  return `${sameDay(state.at, now) ? 'today' : 'tomorrow'} at ${state.time}`;
}
