import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHUTDOWN,
  LOCK_MINUTES,
  LOCK_MS,
  MAX_WARN_MINUTES,
  MIN_WARN_MINUTES,
  clampWarnMinutes,
  MISSED_GRACE_MS,
  describeShutdown,
  formatClock,
  hasMissed,
  formatCountdown,
  isLocked,
  nextShutdownAt,
  normaliseShutdown,
  parseClock,
  refuseShutdownChange,
  shutdownPhase,
  shutdownState,
  sudoReachedShutdown,
} from '../src/shutdown.ts';

/** A local wall clock, which is what every value in this module is stated in. */
function at(year: number, month: number, day: number, hour: number, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

test('parseClock takes a 24h time and nothing else', () => {
  assert.deepEqual(parseClock('19:00'), { hour: 19, minute: 0 });
  assert.deepEqual(parseClock('9:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseClock(' 00:00 '), { hour: 0, minute: 0 });
  for (const bad of ['', '19', '19:0', '24:00', '19:60', '7pm', '19:00:00', '-1:00']) {
    assert.equal(parseClock(bad), undefined, `${bad} is not a time`);
  }
});

test('formatClock pads, because the time input only reads the padded form', () => {
  assert.equal(formatClock({ hour: 9, minute: 5 }), '09:05');
  assert.equal(formatClock({ hour: 19, minute: 0 }), '19:00');
});

test('the next shutdown is today when the time is still ahead', () => {
  const now = at(2026, 3, 10, 14, 30);
  assert.equal(nextShutdownAt('19:00', now), at(2026, 3, 10, 19, 0));
});

test('the next shutdown rolls to tomorrow once the time has passed', () => {
  assert.equal(nextShutdownAt('19:00', at(2026, 3, 10, 19, 30)), at(2026, 3, 11, 19, 0));
  // Strictly after, on the second: this is what stops a tick at 19:00:00 from
  // re-arming for tomorrow over the shutdown that is firing.
  assert.equal(nextShutdownAt('19:00', at(2026, 3, 10, 19, 0)), at(2026, 3, 11, 19, 0));
});

test('the next shutdown keeps the clock time across a DST change', () => {
  // Europe/Paris springs forward on 29 March 2026; the day is 23 hours long, and
  // "19:00" still has to mean 19:00 on the other side of it.
  const armed = nextShutdownAt('19:00', at(2026, 3, 28, 20, 0));
  const when = new Date(armed as number);
  assert.equal(when.getHours(), 19);
  assert.equal(when.getDate(), 29);
});

test('an unreadable time schedules nothing', () => {
  assert.equal(nextShutdownAt('later', Date.now()), undefined);
});

test('the phase turns on the warning window, not on the hour', () => {
  const when = at(2026, 3, 10, 19, 0);
  assert.equal(shutdownPhase(undefined, 15, when), 'off');
  assert.equal(shutdownPhase(when, 15, at(2026, 3, 10, 18, 44)), 'armed');
  assert.equal(shutdownPhase(when, 15, at(2026, 3, 10, 18, 45)), 'warning');
  assert.equal(shutdownPhase(when, 15, at(2026, 3, 10, 18, 59, 59)), 'warning');
  assert.equal(shutdownPhase(when, 15, when), 'due');
  assert.equal(shutdownPhase(when, 15, at(2026, 3, 10, 19, 5)), 'due');
});

test('a shutdown slept through is missed, not fired late', () => {
  const when = at(2026, 3, 10, 19, 0);
  // Busy for a few seconds at 19:00 is still tonight's shutdown.
  assert.equal(hasMissed(when, when), false);
  assert.equal(hasMissed(when, when + MISSED_GRACE_MS), false);
  // The lid opening the next morning is not.
  assert.equal(hasMissed(when, at(2026, 3, 11, 8, 12)), true);
});

test('the permission probe reads shutdown answering, not sudo refusing', () => {
  // What `shutdown` prints as root with no time after it: the rule is in place.
  assert.equal(
    sudoReachedShutdown('usage: shutdown [-] [-h [-u | -n] | -r | -s | -k] time [warning-message ...]\n'),
    true,
  );
  // Every way sudo says no, including the ones that carry no `sudo:` prefix —
  // which is exactly why this is matched on the success instead.
  assert.equal(sudoReachedShutdown('sudo: a password is required\n'), false);
  assert.equal(
    sudoReachedShutdown("Sorry, user kilian is not allowed to execute '/sbin/shutdown' as root on host.\n"),
    false,
  );
  assert.equal(sudoReachedShutdown('kilian is not in the sudoers file.\n'), false);
  assert.equal(sudoReachedShutdown('sudo: a terminal is required to read the password\n'), false);
  // Nothing said at all — no `sudo` on `PATH`. An unanswered question is a no.
  assert.equal(sudoReachedShutdown(''), false);
});

test('warn minutes are clamped to something a person can read and survive', () => {
  assert.equal(clampWarnMinutes(15), 15);
  assert.equal(clampWarnMinutes(0), MIN_WARN_MINUTES);
  assert.equal(clampWarnMinutes(-5), MIN_WARN_MINUTES);
  assert.equal(clampWarnMinutes(999), MAX_WARN_MINUTES);
  assert.equal(clampWarnMinutes(15.4), 15);
  assert.equal(clampWarnMinutes(Number.NaN), DEFAULT_SHUTDOWN.warnMinutes);
  assert.equal(clampWarnMinutes(undefined), DEFAULT_SHUTDOWN.warnMinutes);
});

test('the last five minutes are locked, and the hour arriving unlocks nothing', () => {
  const when = at(2026, 3, 10, 19, 0);
  assert.equal(LOCK_MS, LOCK_MINUTES * 60_000);
  assert.equal(isLocked(undefined, when), false);
  assert.equal(isLocked(when, at(2026, 3, 10, 18, 54)), false);
  // Exactly the lock away is still open: what you may still opt into, you may
  // still opt out of.
  assert.equal(isLocked(when, at(2026, 3, 10, 18, 55)), false);
  assert.equal(isLocked(when, at(2026, 3, 10, 18, 55, 1)), true);
  assert.equal(isLocked(when, when), true);
  assert.equal(isLocked(when, at(2026, 3, 10, 19, 3)), true);
  // The warning can never be shorter than the lock, or minutes would exist in
  // which you could neither see the countdown nor call it off.
  assert.ok(MIN_WARN_MINUTES >= LOCK_MINUTES);
});

test('inside the lock the opt-out and the hour are refused, the warning is not', () => {
  const config = { enabled: true, time: '19:00', warnMinutes: 15 };
  const current = { config, at: at(2026, 3, 10, 19, 0) };
  const now = at(2026, 3, 10, 18, 57);
  assert.match(refuseShutdownChange({ current, next: { ...config, enabled: false }, now }) ?? '', /too late to opt out/);
  assert.match(refuseShutdownChange({ current, next: { ...config, time: '19:30' }, now }) ?? '', /too late to move/);
  assert.equal(refuseShutdownChange({ current, next: { ...config, warnMinutes: 30 }, now }), undefined);
  // Saving what already stands is not a change.
  assert.equal(refuseShutdownChange({ current, next: config, now }), undefined);
  // Due, and still locked.
  const due = at(2026, 3, 10, 19, 2);
  assert.match(refuseShutdownChange({ current, next: { ...config, enabled: false }, now: due }) ?? '', /too late/);
  // Opted out, whatever the scheduler last armed is not a lock.
  const off = { ...config, enabled: false };
  assert.equal(refuseShutdownChange({ current: { config: off, at: current.at }, next: off, now }), undefined);
});

test('outside the lock the evening can be called off or moved — but not into it', () => {
  const config = { enabled: true, time: '19:00', warnMinutes: 15 };
  const current = { config, at: at(2026, 3, 10, 19, 0) };
  const now = at(2026, 3, 10, 18, 50);
  assert.equal(refuseShutdownChange({ current, next: { ...config, enabled: false }, now }), undefined);
  assert.equal(refuseShutdownChange({ current, next: { ...config, time: '19:30' }, now }), undefined);
  assert.match(refuseShutdownChange({ current, next: { ...config, time: '18:53' }, now }) ?? '', /18:53 is under 5 minutes away/);
});

test('an opt-in needs the lock’s worth of notice', () => {
  const off = { enabled: false, time: '19:00', warnMinutes: 15 };
  const current = { config: off, at: undefined };
  const opted = { ...off, enabled: true };
  assert.match(refuseShutdownChange({ current, next: opted, now: at(2026, 3, 10, 18, 56) }) ?? '', /19:00 is under 5 minutes away/);
  // Exactly the lock away is allowed, and so is the whole afternoon.
  assert.equal(refuseShutdownChange({ current, next: opted, now: at(2026, 3, 10, 18, 55) }), undefined);
  assert.equal(refuseShutdownChange({ current, next: opted, now: at(2026, 3, 10, 14, 0) }), undefined);
  // Just past the hour, the shutdown it would arm is tomorrow's.
  assert.equal(refuseShutdownChange({ current, next: opted, now: at(2026, 3, 10, 19, 0, 30) }), undefined);
  // An unreadable time is not refused here: normalising turns it off instead.
  assert.equal(refuseShutdownChange({ current, next: { ...opted, time: 'later' }, now: at(2026, 3, 10, 18, 56) }), undefined);
});

test('the state says when it is locked', () => {
  const config = { enabled: true, time: '19:00', warnMinutes: 15 };
  const when = at(2026, 3, 10, 19, 0);
  assert.equal(shutdownState({ config, at: when, now: at(2026, 3, 10, 18, 50) }).locked, false);
  assert.equal(shutdownState({ config, at: when, now: at(2026, 3, 10, 18, 58) }).locked, true);
  assert.equal(shutdownState({ config: { ...config, enabled: false }, at: when, now: at(2026, 3, 10, 18, 58) }).locked, false);
});

test('a hand-edited config cannot arm a shutdown at an hour nobody wrote', () => {
  assert.deepEqual(normaliseShutdown({ enabled: true, time: '19:0', warnMinutes: 15 }), {
    enabled: false,
    time: DEFAULT_SHUTDOWN.time,
    warnMinutes: 15,
  });
  assert.deepEqual(normaliseShutdown(undefined), DEFAULT_SHUTDOWN);
  // Opting in is a boolean and only a boolean: a truthy string in the file is a
  // typo, not consent to turn the machine off.
  assert.equal(normaliseShutdown({ enabled: 'yes' as unknown as boolean, time: '19:00' }).enabled, false);
});

test('opted out, the state carries the schedule but arms nothing', () => {
  const state = shutdownState({
    config: { enabled: false, time: '19:00', warnMinutes: 15 },
    at: at(2026, 3, 10, 19, 0),
    now: at(2026, 3, 10, 18, 50),
  });
  assert.equal(state.at, undefined);
  assert.equal(state.phase, 'off');
  assert.equal(state.msLeft, undefined);
  // Still says 19:00: the tab is a form, and opting out must not clear the hour.
  assert.equal(state.time, '19:00');
});

test('the countdown never runs past zero', () => {
  const state = shutdownState({
    config: { enabled: true, time: '19:00', warnMinutes: 15 },
    at: at(2026, 3, 10, 19, 0),
    now: at(2026, 3, 10, 19, 4),
  });
  assert.equal(state.phase, 'due');
  assert.equal(state.msLeft, 0);
});

test('the countdown reads as a clock', () => {
  assert.equal(formatCountdown(15 * 60_000), '15:00');
  assert.equal(formatCountdown(59_400), '01:00');
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-5_000), '00:00');
  assert.equal(formatCountdown(90 * 60_000), '1:30:00');
  // Ceiling, not floor: the last partial second is still a second of notice.
  assert.equal(formatCountdown(1_200), '00:02');
});

test('the tab says which day the machine goes down on', () => {
  const now = at(2026, 3, 10, 23, 50);
  const config = { enabled: true, time: '00:05', warnMinutes: 15 };
  const tomorrow = shutdownState({ config, at: at(2026, 3, 11, 0, 5), now });
  assert.equal(describeShutdown(tomorrow, now), 'tomorrow at 00:05');

  const later = at(2026, 3, 10, 14, 0);
  const today = shutdownState({ config: { ...config, time: '19:00' }, at: at(2026, 3, 10, 19, 0), now: later });
  assert.equal(describeShutdown(today, later), 'today at 19:00');

  assert.equal(describeShutdown(shutdownState({ config: { ...config, enabled: false }, at: undefined, now }), now), 'nothing scheduled');
});
