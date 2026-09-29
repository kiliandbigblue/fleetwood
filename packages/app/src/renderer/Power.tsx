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
import type { FleetState } from '@fleetwood/core';
import { duration, send } from './api.ts';
import { useNow } from './useNow.ts';

/** The sudoers line that lets the schedule actually fire — see the README. */
const SUDOERS_LINE = '%admin ALL=(root) NOPASSWD: /sbin/shutdown';

interface Props {
  shutdown: ShutdownState;
  /** The fleet's agents, for saying what the shutdown will stop. */
  counts: FleetState['counts'];
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
export function Power({ shutdown, counts, onResult }: Props): React.JSX.Element {
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
        // Only a refusal is worth a toast: success is the head line changing.
        if (!result.ok) onResult(result.detail, false);
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

  /*
   * Saved once the typing stops, not on every keystroke.
   *
   * A time field reports each digit as it lands, so typing 2130 armed a real
   * 02:00 shutdown, then 21:00, then 21:03 on the way to 21:30 — four schedules,
   * one of them for the middle of the night. A beat after the last change, or
   * on leaving the field, whichever comes first.
   */
  const warnValid = Number.isFinite(warnMinutes) && warnMinutes >= MIN_WARN_MINUTES && warnMinutes <= MAX_WARN_MINUTES;
  const pending = (time !== shutdown.time && parseClock(time) !== undefined) ||
    (warnMinutes !== shutdown.warnMinutes && warnValid);
  const commit = (): void => {
    if (!pending) return;
    save({
      ...shutdown,
      time: parseClock(time) ? time : shutdown.time,
      warnMinutes: warnValid ? warnMinutes : shutdown.warnMinutes,
    });
  };
  // Keyed on the two values, not on every render: the tab redraws each second
  // with the clock, and that must not keep pushing the save back.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(commit, 900);
    return () => clearTimeout(timer);
  }, [time, warnMinutes, pending]);

  const onToggleEnabled = (): void =>
    save({
      ...shutdown,
      enabled: !shutdown.enabled,
      time: parseClock(time) ? time : shutdown.time,
      warnMinutes: warnValid ? warnMinutes : shutdown.warnMinutes,
    });

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
  /*
   * What the shutdown will take with it, said while there is time to act.
   *
   * The one fact only this panel has: which agents are mid-turn or waiting on
   * you right now, and so would be cut off at the hour.
   */
  const running = counts.working + counts.compacting;
  const stopped = [
    running > 0 ? `${running} agent${running === 1 ? '' : 's'} working` : '',
    counts.blocked_permission > 0 ? `${counts.blocked_permission} waiting on a permission prompt` : '',
  ].filter(Boolean);

  return (
    <>
      <div className="section-title" role="heading" aria-level={2}>
        end of day · this Mac
      </div>
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
        </div>

        {/*
         * A switch, not an "opt in / opt out" pair of buttons. It says what it
         * is — shut down every day — and whether that is on; red went on the
         * healthy armed state, and consent-form words on a setting.
         */}
        <button
          type="button"
          role="switch"
          aria-checked={shutdown.enabled}
          className={`power-switch${shutdown.enabled ? ' on' : ''}`}
          onClick={onToggleEnabled}
          disabled={locked || tooSoon}
        >
          <span className="power-switch-track" aria-hidden="true">
            <span className="power-switch-thumb" />
          </span>
          <span className="power-label">shut down every day</span>
        </button>
        {/* Why the switch will not move, said as text — a disabled control
            cannot take focus, so a reason in its tooltip reached nobody. */}
        {tooSoon && (
          <div className="power-hint">
            {time} is under {LOCK_MINUTES} minutes away — pick a later time to turn it on.
          </div>
        )}
        {shutdown.enabled && shutdown.phase !== 'due' && (
          <div className="power-hint">
            {stopped.length > 0
              ? `this stops ${stopped.join(' and ')} — your notes are kept.`
              : `nothing is running now — your notes are kept.`}
          </div>
        )}

        <label className="power-field">
          <span className="power-label">shut down at</span>
          {/* Fixed inside the lock: moving the hour is the opt-out wearing a hat. */}
          <input
            className="field power-time"
            type="time"
            value={time}
            disabled={locked}
            // A time input hands over `''` while being cleared and half-typed
            // hours on the way; the field keeps them, `commit` only saves a
            // real clock.
            onChange={(event) => setTime(event.target.value)}
            onBlur={commit}
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
            aria-invalid={!warnValid}
            aria-describedby={warnValid ? undefined : 'power-warn-range'}
            onChange={(event) => setWarnMinutes(Number(event.target.value))}
            onBlur={() => {
              // Out of range is walked back to what stands, rather than left
              // showing a number the schedule never took.
              if (!warnValid) setWarnMinutes(shutdown.warnMinutes);
              else commit();
            }}
          />
          <span className="power-label">minutes before, full screen</span>
        </label>
        {!warnValid && (
          <div className="power-hint power-hint-warn" id="power-warn-range" role="status">
            between {MIN_WARN_MINUTES} and {MAX_WARN_MINUTES} minutes — still {shutdown.warnMinutes} until then.
          </div>
        )}

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

        {shutdown.error && (
          <div className="power-error" role="alert">
            last attempt failed — {shutdown.error}. Check the sudo line above, then turn the switch off and on
            to try again.
          </div>
        )}
      </div>
    </>
  );
}
