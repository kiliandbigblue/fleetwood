import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, fetchLimits, parseLimits } from '../src/limits.ts';

const NOW = 1_800_000_000;

/**
 * A real `/api/oauth/usage` response, trimmed but otherwise verbatim.
 *
 * Recorded from a live call and checked against the desktop app showing "77%
 * used" and "40% used" at the same moment. An earlier version of this fixture
 * was written from a guess at the shape — `utilization` as a 0..1 fraction —
 * and every test passed while the UI rendered every bar at 100%. Keep this
 * honest: it is the only thing standing between a plausible parse and a wrong one.
 */
const RESPONSE = {
  five_hour: {
    utilization: 77,
    resets_at: '2026-08-04T23:09:59.573248+00:00',
    limit_dollars: null,
    used_dollars: null,
  },
  seven_day: {
    utilization: 40,
    resets_at: '2026-08-06T13:00:00.573269+00:00',
    limit_dollars: null,
  },
  // Windows that don't apply to the plan are present and null, not omitted.
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  // Unrelated codenames that share the payload.
  tangelo: null,
  iguana_necktie: null,
  nimbus_quill: null,
  extra_usage: { is_enabled: false, utilization: null, user_disabled: true },
  limits: [
    { kind: 'session', group: 'session', percent: 77, scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 40, scope: null, is_active: false },
  ],
  // A credits object, not a quota window — it has a `percent` all the same.
  spend: { used: { amount_minor: 0, currency: 'USD' }, percent: 0, enabled: false },
  member_dashboard_available: false,
};

test('utilization is a whole percent, not a fraction', () => {
  // The bug this exists to prevent: reading 77 as a 0..1 fraction clamped every
  // bar to 100% while the desktop app showed 77% and 40%.
  const limits = parseLimits(RESPONSE, NOW);
  assert.equal(limits.windows.find((w) => w.key === 'five_hour')?.utilization, 0.77);
  assert.equal(limits.windows.find((w) => w.key === 'seven_day')?.utilization, 0.4);
});

test('reads the applicable windows, in reading order, titled as /usage does', () => {
  const limits = parseLimits(RESPONSE, NOW);
  assert.deepEqual(
    limits.windows.map((w) => w.title),
    ['Current session', 'Current week (all models)'],
  );
  // The window that stalls you soonest reads first.
  assert.equal(limits.windows[0]?.key, 'five_hour');
  assert.equal(
    limits.windows[0]?.resetsAt,
    Math.floor(Date.parse('2026-08-04T23:09:59.573248+00:00') / 1000),
  );
  assert.equal(limits.fetchedAt, NOW);
  assert.equal(limits.stale, undefined);
});

test('non-window objects that happen to carry a percent are not rendered as bars', () => {
  const keys = parseLimits(RESPONSE, NOW).windows.map((w) => w.key);
  // `spend` is a credits object with `percent: 0`; it put a bogus "spend 0%" bar
  // on screen when unknown keys were surfaced generically.
  assert.ok(!keys.includes('spend'));
  assert.ok(!keys.includes('extra_usage'));
  assert.ok(!keys.some((k) => ['tangelo', 'iguana_necktie', 'nimbus_quill'].includes(k)));
});

test('windows that do not apply to the plan are null, and stay off the panel', () => {
  const keys = parseLimits(RESPONSE, NOW).windows.map((w) => w.key);
  assert.ok(!keys.includes('seven_day_opus'));
  assert.ok(!keys.includes('seven_day_sonnet'));
});

test('a window that does apply is picked up once populated', () => {
  const limits = parseLimits(
    { ...RESPONSE, seven_day_opus: { utilization: 12, resets_at: '2026-08-06T13:00:00Z' } },
    NOW,
  );
  const opus = limits.windows.find((w) => w.key === 'seven_day_opus');
  assert.equal(opus?.title, 'Current week (Opus only)');
  assert.equal(opus?.utilization, 0.12);
});

test('the limits array contributes only per-model caps, never duplicates', () => {
  // It repeats session and weekly_all with `scope: null`; those are already
  // rendered from the named keys, so counting them again would double the panel.
  assert.equal(parseLimits(RESPONSE, NOW).windows.length, 2);

  const withScoped = parseLimits(
    {
      ...RESPONSE,
      limits: [
        ...RESPONSE.limits,
        {
          kind: 'weekly_scoped',
          percent: 31,
          resets_at: '2026-08-06T13:00:00Z',
          scope: { model: { display_name: 'Opus 5' } },
        },
      ],
    },
    NOW,
  );
  const scoped = withScoped.windows.find((w) => w.key === 'weekly_scoped:Opus 5');
  assert.equal(scoped?.title, 'Current week (Opus 5)');
  // The rail's one-word name: the family, not the version and not the vendor.
  assert.equal(scoped?.short, 'opus');
  // That branch reads `percent` where the named windows use `utilization`.
  assert.equal(scoped?.utilization, 0.31);
});

test('utilization is clamped to the 0..100 the endpoint promises', () => {
  const limits = parseLimits(
    { five_hour: { utilization: 140 }, seven_day: { utilization: -5 } },
    NOW,
  );
  const by = (key: string): number | undefined =>
    limits.windows.find((w) => w.key === key)?.utilization;
  assert.equal(by('five_hour'), 1);
  assert.equal(by('seven_day'), 0);
});

test('reset timestamps are accepted as ISO, seconds, or milliseconds', () => {
  // The endpoint sends offset-suffixed ISO; the numeric forms are tolerated in
  // case that changes, since a wrong unit here reads as "resets in 55 years".
  const at = (resets: unknown): number | undefined =>
    parseLimits({ five_hour: { utilization: 10, resets_at: resets } }, NOW).windows[0]?.resetsAt;

  assert.equal(
    at('2026-08-04T23:09:59.573248+00:00'),
    Math.floor(Date.parse('2026-08-04T23:09:59.573248+00:00') / 1000),
  );
  assert.equal(at(1_800_000_500), 1_800_000_500);
  assert.equal(at(1_800_000_500_000), 1_800_000_500);
  assert.equal(at(undefined), undefined);
  assert.equal(at('not a date'), undefined);
});

test('a window with no usable utilization is dropped, not rendered as empty', () => {
  const limits = parseLimits(
    { five_hour: { resets_at: 1_800_000_500 }, seven_day: { utilization: 50 } },
    NOW,
  );
  assert.deepEqual(
    limits.windows.map((w) => w.key),
    ['seven_day'],
  );
});

test('garbage in gives an empty panel rather than a crash', () => {
  // This decorates a panel whose real job is tmux; it must never be able to
  // take that panel down.
  for (const body of [null, undefined, 'nonsense', 42, [], { limits: 'not an array' }]) {
    assert.deepEqual(parseLimits(body, NOW).windows, []);
  }
  // A scoped entry with no model name is unrenderable, so it is skipped.
  assert.deepEqual(parseLimits({ limits: [{ kind: 'weekly_scoped', percent: 50 }] }, NOW).windows, []);
});

test('extracts a token whether the command prints JSON or a bare string', () => {
  assert.equal(extractToken('sk-ant-oat01-abc\n'), 'sk-ant-oat01-abc');
  // Claude Code stores a nested blob; find the token wherever it sits.
  assert.equal(
    extractToken('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-xyz","expiresAt":123}}'),
    'sk-ant-oat01-xyz',
  );
  assert.equal(extractToken('{"access_token":"snake-case"}'), 'snake-case');
  // A trailing newline and surrounding whitespace are normal from `security`.
  assert.equal(extractToken('  padded-token  '), 'padded-token');
});

test('no token means no panel, and no exception', () => {
  assert.equal(extractToken(''), undefined);
  assert.equal(extractToken('   \n'), undefined);
  assert.equal(extractToken('{"nothing":"useful"}'), undefined);
  assert.equal(extractToken('{ truncated json'), undefined);
});

test('the feature is inert until a token command is configured', async () => {
  // No command means no subprocess and no request — the default state must be
  // completely silent, not a failed fetch every poll.
  assert.equal(await fetchLimits({}), undefined);
  assert.equal(await fetchLimits({ tokenCommand: '   ' }), undefined);
});

test('a token command that fails yields nothing rather than throwing', async () => {
  assert.equal(await fetchLimits({ tokenCommand: 'exit 1' }), undefined);
  assert.equal(await fetchLimits({ tokenCommand: 'echo ""' }), undefined);
});
