import { useEffect, useState } from 'react';
import {
  LOCK_MINUTES,
  LOCK_MS,
  MAX_WARN_MINUTES,
  MIN_WARN_MINUTES,
  describeShutdown,
  nextShutdownAt,
  parseClock,
} from '@fleetwood/core/shutdown';
import type { ShutdownConfig, ShutdownState } from '@fleetwood/core/shutdown';
import { duration, send } from './api.ts';
import { useNow } from './useNow.ts';

/** The sudoers line that lets the schedule actually fire — see the README. */
const SUDOERS_LINE = '%admin ALL=(root) NOPASSWD: /sbin/shutdown';

interface Props {
  shutdown: ShutdownState;
  onResult: (message: string, ok: boolean) => void;
}

/**
 * The power tab: when this machine stops for the day, and whether it does at all.
 *
 * One card and three fields, because it is one decision — off at 19:00, shout at
 * 18:45 — and the whole of it fits on the panel without scrolling. The opt-in is
 * a switch rather than an empty time meaning "never": you set the hour once and
 * spend the rest of its life turning it on and off.
 */
export function Power({ shutdown, onResult }: Props): React.JSX.Element {
  /*
   * The fields' own values, so typing is not fighting the 1s snapshot poll — the
   * same arrangement as the opacity slider. They follow the config whenever it
   * changes, including a hand edit of `~/.fleetwood/config.json`.
   */
  const [time, setTime] = useState(shutdown.time);
  const [warnMinutes, setWarnMinutes] = useState(shutdown.warnMinutes);
  useEffect(() => setTime(shutdown.time), [shutdown.time]);
  useEffect(() => setWarnMinutes(shutdown.warnMinutes), [shutdown.warnMinutes]);

  const now = useNow();

  /*
   * Sent whole, and only the three keys.
   *
   * The state this tab is drawn from carries what the scheduler knows as well —
   * when it is armed for, whether sudo will have it — and none of that is the
   * renderer's to write back.
   */
  const save = (next: ShutdownConfig): void => {
    const { enabled, time: when, warnMinutes: warn } = next;
    void send({ kind: 'setShutdown', shutdown: { enabled, time: when, warnMinutes: warn } }).then(
      (result) => {
        onResult(result.detail, result.ok);
        // Refused — the lock, see `refuseShutdownChange`. Nothing reached the
        // disk, so no snapshot will move the fields back; they are walked back
        // here to the schedule that still stands.
        if (!result.ok) {
          setTime(shutdown.time);
          setWarnMinutes(shutdown.warnMinutes);
        }
      },
    );
  };

  const onPickTime = (next: string): void => {
    setTime(next);
    // A time input hands over `''` while it is being cleared, and half-typed
    // hours as you arrow through them. Neither is a schedule; the field keeps
    // them and the config does not.
    if (parseClock(next)) save({ ...shutdown, time: next, warnMinutes });
  };

  const onPickWarning = (next: number): void => {
    setWarnMinutes(next);
    if (Number.isFinite(next) && next >= MIN_WARN_MINUTES && next <= MAX_WARN_MINUTES) {
      save({ ...shutdown, time, warnMinutes: next });
    }
  };

  const onToggleEnabled = (): void => save({ ...shutdown, enabled: !shutdown.enabled, time, warnMinutes });

  const when = describeShutdown(shutdown, now);
  const left = shutdown.at === undefined ? '' : duration(Math.round((shutdown.at - now) / 1000));

  /*
   * The lock, drawn before it is hit: a button that has gone grey says why a
   * click would be refused better than the refusal does. `locked` is the
   * scheduler's word on the armed shutdown; `tooSoon` is the same rule from the
   * other side, asked of the time in the field rather than the one armed, so it
   * follows what you type and lifts on its own as the clock moves past the hour.
   */
  const locked = shutdown.enabled && shutdown.locked;
  const wouldArm = nextShutdownAt(time, now);
  const tooSoon = !shutdown.enabled && wouldArm !== undefined && wouldArm - now < LOCK_MS;
  const toggleTitle = locked
    ? `under ${LOCK_MINUTES} minutes to go — too late to call it off`
    : tooSoon
      ? `${time} is under ${LOCK_MINUTES} minutes away — pick a later time`
      : shutdown.enabled
        ? 'stop shutting this machine down at the end of the day'
        : 'shut this machine down at the time below, every day';

  return (
    <>
      <div className="section-title">end of day — this machine, not the fleet</div>
      <div className="card power">
        <div className="power-head">
          <div className="power-when">
            <span className={`power-state${shutdown.enabled ? ' on' : ''}`}>{when}</span>
            {/* The countdown only while something is coming: on a tab that is
                off, a dash where a duration goes reads as a duration failing. */}
            {shutdown.enabled && shutdown.at !== undefined && shutdown.phase !== 'due' && (
              <span className="power-left">in {left}</span>
            )}
          </div>
          <button
            className={`button${shutdown.enabled ? ' deny' : ' approve'}`}
            onClick={onToggleEnabled}
            disabled={locked || tooSoon}
            title={toggleTitle}
          >
            {shutdown.enabled ? 'opt out' : 'opt in'}
          </button>
        </div>

        <label className="power-field">
          <span className="power-label">shut down at</span>
          {/* Fixed inside the lock: moving the hour is the opt-out wearing a hat. */}
          <input
            className="field power-time"
            type="time"
            value={time}
            disabled={locked}
            onChange={(event) => onPickTime(event.target.value)}
          />
        </label>

        <label className="power-field">
          <span className="power-label">warn me</span>
          <input
            className="field power-warn"
            type="number"
            min={MIN_WARN_MINUTES}
            max={MAX_WARN_MINUTES}
            value={warnMinutes}
            onChange={(event) => onPickWarning(Number(event.target.value))}
          />
          <span className="power-label">minutes before, full screen</span>
        </label>

        {/* Said once the button has gone grey, so the grey is not a mystery. */}
        {locked && (
          <div className="power-locked">
            under {LOCK_MINUTES} minutes to go — it can’t be called off any more. save your work.
          </div>
        )}

        {/*
          Said here rather than at 19:00, which is the only other place it could
          be said and far too late: the schedule is armed and will still do
          nothing, because turning the machine off needs a line in
          `/etc/sudoers.d` that fleetwood may not write for you.
        */}
        {shutdown.permitted === false && (
          <div className="power-blocked">
            <div>
              sudo won’t run the shutdown without a password, so nothing will happen at {shutdown.time}.
              Add it with <code>sudo visudo -f /etc/sudoers.d/fleetwood-shutdown</code>:
            </div>
            <code className="power-sudoers">{SUDOERS_LINE}</code>
          </div>
        )}

        {shutdown.error && <div className="power-error">last attempt failed — {shutdown.error}</div>}
      </div>
    </>
  );
}
