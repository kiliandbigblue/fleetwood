import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `paths.ts` reads FLEETWOOD_HOME at module load, so this must be set before the
// first import of anything that pulls it in — hence the dynamic imports below.
const home = await mkdtemp(join(tmpdir(), 'fw-history-'));
process.env.FLEETWOOD_HOME = home;
const { buildArchivedTask, loadHistory, parseHistory, recordArchive } = await import(
  '../src/taskHistory.ts'
);
const { HISTORY_LOG } = await import('../src/paths.ts');

const record = {
  slug: 'tasks-history',
  branch: 'feature/tasks-history',
  type: 'feature',
  microservice: 'tasks',
  summary: 'history',
  goal: 'keep archived tasks somewhere',
  createdAt: 1_788_524_425,
};

test('the record keeps what the folder was about to take with it', () => {
  const built = buildArchivedTask({
    task: record,
    repos: [
      { name: 'fleetwood-tasks-history', path: '/tmp/x', repo: 'kiliandbigblue/fleetwood', branch: 'feature/tasks-history', dirty: 0 },
    ],
    prs: [
      {
        repo: 'kiliandbigblue/fleetwood',
        number: 42,
        title: 'history tab',
        url: 'https://github.com/kiliandbigblue/fleetwood/pull/42',
        updatedAt: '2026-09-04T10:00:00Z',
        isDraft: true,
        roles: ['mine'],
        branch: 'feature/tasks-history',
        via: 'head',
        reviewDecision: 'APPROVED',
      },
    ],
    now: 1_788_600_000_000,
  });

  assert.equal(built.slug, 'tasks-history');
  assert.equal(built.goal, 'keep archived tasks somewhere');
  // Seconds, like every other stamp in the codebase — not the millis passed in.
  assert.equal(built.archivedAt, 1_788_600_000);
  // `owner/name`, not the worktree directory name: the directory is gone.
  assert.deepEqual(built.repos, [
    { repo: 'kiliandbigblue/fleetwood', branch: 'feature/tasks-history' },
  ]);
  assert.equal(built.prs[0]?.number, 42);
  assert.equal(built.prs[0]?.reviewDecision, 'APPROVED');
  // The live-only fields of a TaskPr are not worth freezing — `via` describes how
  // the branch was discovered, which is meaningless once it cannot be re-derived.
  assert.equal('via' in (built.prs[0] as object), false);
});

test('a worktree with no known owner still names itself', () => {
  // `repo` is optional on a TaskRepo — git would not always say. Falling back to
  // the directory name keeps a row that says *something* about where work went.
  const built = buildArchivedTask({
    task: record,
    repos: [{ name: 'some-worktree', path: '/tmp/y', dirty: 0 }],
  });
  assert.deepEqual(built.repos, [{ repo: 'some-worktree' }]);
});

test('archiving without pull requests records an empty list, not a hole', () => {
  // `fw task archive` has none to pass and will not make a network call for them.
  const built = buildArchivedTask({ task: record, repos: [] });
  assert.deepEqual(built.prs, []);
  assert.deepEqual(built.repos, []);
});

test('rows append and come back newest first', async () => {
  // Also the fresh-install case: FLEETWOOD_HOME is an empty tmpdir at this point,
  // so no log exists yet and that reads as an empty history rather than throwing.
  assert.deepEqual(await loadHistory(), []);

  await recordArchive({ task: record, repos: [], now: 1_788_000_000_000 });
  await recordArchive({
    task: { ...record, slug: 'later-task', summary: 'later' },
    repos: [],
    now: 1_788_900_000_000,
  });
  await recordArchive({
    task: { ...record, slug: 'middle-task', summary: 'middle' },
    repos: [],
    now: 1_788_500_000_000,
  });

  const history = await loadHistory();
  assert.deepEqual(
    history.map((entry) => entry.slug),
    ['later-task', 'middle-task', 'tasks-history'],
  );

  // Appended, not rewritten: one line per archive, so a write cannot corrupt
  // what is already in the file.
  const raw = await readFile(HISTORY_LOG, 'utf8');
  assert.equal(raw.trim().split('\n').length, 3);
});

test('the same slug archived twice keeps both rows', async () => {
  // A slug is reused freely — the folder is gone, so nothing stops you starting
  // another task by the same name. History is a log, not a keyed store.
  const history = await loadHistory();
  const before = history.filter((entry) => entry.slug === 'tasks-history').length;
  await recordArchive({ task: record, repos: [], now: 1_789_000_000_000 });
  const after = (await loadHistory()).filter((entry) => entry.slug === 'tasks-history');
  assert.equal(after.length, before + 1);
});

test('one unreadable line does not take the log down with it', () => {
  const good = JSON.stringify({ version: 1, slug: 'a', archivedAt: 2, repos: [], prs: [] });
  const other = JSON.stringify({ version: 1, slug: 'b', archivedAt: 1, repos: [], prs: [] });
  const parsed = parseHistory(
    [
      good,
      'not json at all',
      // A row from a future version could be missing fields the UI reads.
      JSON.stringify({ version: 2, slug: 'from-the-future' }),
      '',
      other,
      // The expected case: a half-written final line after a crash mid-append.
      '{"version":1,"slug":"trunc',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.map((entry) => entry.slug),
    ['a', 'b'],
  );
});

test('missing repos and prs arrays are filled in on read', () => {
  // Hand-edited or older rows would otherwise crash the renderer on `.map`.
  const parsed = parseHistory(JSON.stringify({ version: 1, slug: 'a', archivedAt: 1 }));
  assert.deepEqual(parsed[0]?.repos, []);
  assert.deepEqual(parsed[0]?.prs, []);
});

test('a row written by a newer fleetwood is skipped rather than half-read', async () => {
  await appendFile(HISTORY_LOG, `${JSON.stringify({ version: 9, slug: 'nope' })}\n`, 'utf8');
  const slugs = (await loadHistory()).map((entry) => entry.slug);
  assert.equal(slugs.includes('nope'), false);
});
