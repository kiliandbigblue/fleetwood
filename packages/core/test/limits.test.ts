import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, fetchLimits, parseLimits } from '../src/limits.ts';

const NOW = 1_800_000_000;

/**
 * The shape `/api/oauth/usage` returns: named windows plus a `limits` array for
 * per-model weekly caps. Read off Claude Code's own parsing, so it is what the
 * endpoint actually sends rather than a guess.
 */
const RESPONSE = {
  five_hour: { utilization: 0.57, resets_at: '2027-01-15T18:40:00.000Z' },
  seven_day: { utilization: 0.22, resets_at: '2027-01-18T00:00:00.000Z' },
  seven_day_sonnet: { utilization: 0.05, resets_at: '2027-01-18T00:00:00.000Z' },
  limits: [
    {
      kind: 'weekly_scoped',
      percent: 0.31,
      resets_at: '2027-01-18T00:00:00.000Z',
      scope: { model: { display_name: 'Opus 5' } },
    },
  ],
};

test('reads the named windows and names them as /usage does', () => {
  const limits = parseLimits(RESPONSE, NOW);
  const session = limits.windows[0];

  // five_hour sorts first: it is the window that stalls you soonest.
  assert.equal(session?.key, 'five_hour');
  assert.equal(session?.title, 'Current session');
  assert.equal(session?.utilization, 0.57);
  assert.equal(session?.resetsAt, Math.floor(Date.parse('2027-01-15T18:40:00.000Z') / 1000));

  assert.deepEqual(
    limits.windows.map((w) => w.title),
    [
      'Current session',
      'Current week (all models)',
      'Current week (Sonnet only)',
      'Current week (Opus 5)',
    ],
  );
  assert.equal(limits.fetchedAt, NOW);
  assert.equal(limits.stale, undefined);
});

test('per-model weekly caps come off the limits array, not a named key', () => {
  const scoped = parseLimits(RESPONSE, NOW).windows.find((w) => w.key.startsWith('weekly_scoped:'));
  assert.equal(scoped?.title, 'Current week (Opus 5)');
  // That branch reads `percent` where the named windows use `utilization`.
  assert.equal(scoped?.utilization, 0.31);
});

test('an unrecognised window still shows up, under its raw name', () => {
  // The endpoint is internal and can add windows; a new one appearing must not
  // cost us the ones we do understand.
  const limits = parseLimits({ ...RESPONSE, some_new_window: { utilization: 0.4 } }, NOW);
  const added = limits.windows.find((w) => w.key === 'some_new_window');
  assert.equal(added?.title, 'some new window');
  assert.equal(added?.utilization, 0.4);
  // And it sorts after the windows we have an opinion about.
  assert.equal(limits.windows[0]?.key, 'five_hour');
});

test('utilization is clamped to a fraction, never rescaled', () => {
  const limits = parseLimits(
    { over: { utilization: 1.4 }, under: { utilization: -0.2 }, exact: { utilization: 0.57 } },
    NOW,
  );
  const by = (key: string): number | undefined =>
    limits.windows.find((w) => w.key === key)?.utilization;
  // 1.4 is 140% of a blown limit, not 1.4% — it must not be divided by 100.
  assert.equal(by('over'), 1);
  assert.equal(by('under'), 0);
  assert.equal(by('exact'), 0.57);
});

test('reset timestamps are accepted as ISO, seconds, or milliseconds', () => {
  const limits = parseLimits(
    {
      iso: { utilization: 0.1, resets_at: '2027-01-15T18:40:00.000Z' },
      secs: { utilization: 0.1, resets_at: 1_800_000_500 },
      millis: { utilization: 0.1, resets_at: 1_800_000_500_000 },
      absent: { utilization: 0.1 },
      junk: { utilization: 0.1, resets_at: 'not a date' },
    },
    NOW,
  );
  const at = (key: string): number | undefined =>
    limits.windows.find((w) => w.key === key)?.resetsAt;
  assert.equal(at('iso'), Math.floor(Date.parse('2027-01-15T18:40:00.000Z') / 1000));
  assert.equal(at('secs'), 1_800_000_500);
  assert.equal(at('millis'), 1_800_000_500);
  assert.equal(at('absent'), undefined);
  assert.equal(at('junk'), undefined);
});

test('a window with no usable utilization is dropped, not rendered as empty', () => {
  const limits = parseLimits(
    { five_hour: { resets_at: 1_800_000_500 }, seven_day: { utilization: 0.5 } },
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
  assert.deepEqual(parseLimits({ limits: [{ percent: 0.5 }] }, NOW).windows, []);
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
