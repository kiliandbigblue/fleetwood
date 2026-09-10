import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRepoBranchPrs } from '../src/github.ts';
import type { GqlPayload, RepoBranch } from '../src/github.ts';

const pairs: RepoBranch[] = [
  { repo: 'bigbluedisco/atlas', branch: 'feature/a' },
  { repo: 'bigbluedisco/reflow', branch: 'feature/b' },
];

/** One `pullRequests` alias, carrying only the fields a case cares about. */
type Alias = NonNullable<NonNullable<GqlPayload['data']>[string]>;

function alias(node: Record<string, unknown>): Alias {
  return { pullRequests: { nodes: [node] } } as unknown as Alias;
}

const base = {
  number: 1,
  title: 'a',
  url: 'https://github.com/bigbluedisco/atlas/pull/1',
  updatedAt: '2026-09-10T10:00:00Z',
  isDraft: false,
  headRefName: 'feature/a',
  baseRefName: 'dev',
};

test('the repo comes from the question, since the answer does not carry it', () => {
  const payload: GqlPayload = { data: { p0: alias(base), p1: alias({ ...base, number: 7, headRefName: 'feature/b' }) } };
  const prs = decodeRepoBranchPrs(payload, pairs);
  assert.deepEqual(
    prs.map((pr) => [pr.repo, pr.number, pr.branch, pr.base]),
    [
      ['bigbluedisco/atlas', 1, 'feature/a', 'dev'],
      ['bigbluedisco/reflow', 7, 'feature/b', 'dev'],
    ],
  );
});

test('a check run and a legacy status are both counted, out of one union', () => {
  const payload: GqlPayload = {
    data: {
      p0: alias({
        ...base,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: 'CheckRun',
                        name: 'test',
                        status: 'COMPLETED',
                        conclusion: 'SUCCESS',
                        startedAt: '2026-09-10T09:00:00Z',
                        checkSuite: { workflowRun: { workflow: { name: 'Test and lint' } } },
                      },
                      { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', createdAt: '2026-09-10T09:00:00Z' },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    },
  };
  const [pr] = decodeRepoBranchPrs(payload, pairs);
  assert.deepEqual(pr?.checksDetail, { passing: 1, failing: 1, pending: 0 });
  assert.equal(pr?.checks, 'failing');
});

test('a superseded attempt on the same commit does not outvote its retry', () => {
  // The force-push case `latestAttempts` exists for, reached through the
  // GraphQL shape: the workflow name arrives nested, and identity depends on it.
  const run = (conclusion: string, startedAt: string): Record<string, unknown> => ({
    __typename: 'CheckRun',
    name: 'test (0)',
    status: 'COMPLETED',
    conclusion,
    startedAt,
    checkSuite: { workflowRun: { workflow: { name: 'Test' } } },
  });
  const payload: GqlPayload = {
    data: {
      p0: alias({
        ...base,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [run('CANCELLED', '2026-09-10T09:00:00Z'), run('SUCCESS', '2026-09-10T09:05:00Z')] },
                },
              },
            },
          ],
        },
      }),
    },
  };
  const [pr] = decodeRepoBranchPrs(payload, pairs);
  assert.equal(pr?.checks, 'passing');
  assert.deepEqual(pr?.checksDetail, { passing: 1, failing: 0, pending: 0 });
});

test('the ignore pattern still drops advisory checks', () => {
  const payload: GqlPayload = {
    data: {
      p0: alias({
        ...base,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: 'CheckRun', name: 'codecov/patch', status: 'COMPLETED', conclusion: 'FAILURE' },
                      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    },
  };
  const [pr] = decodeRepoBranchPrs(payload, pairs, 'codecov');
  assert.equal(pr?.checks, 'passing');
});

test('a re-requested review reads as waiting on the reviewer, as it does over REST', () => {
  const payload: GqlPayload = {
    data: {
      p0: alias({ ...base, reviewDecision: 'CHANGES_REQUESTED', latestReviews: { nodes: [{ state: 'COMMENTED' }] } }),
      p1: alias({
        ...base,
        number: 2,
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] },
      }),
    },
  };
  const prs = decodeRepoBranchPrs(payload, pairs);
  assert.equal(prs[0]?.reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(prs[1]?.reviewDecision, 'CHANGES_REQUESTED');
});

test('one dead alias does not cost the document its other answers', () => {
  // GitHub returns null for a repo that was renamed or is no longer visible,
  // and `gh` exits non-zero for the accompanying `errors` — with every other
  // alias perfectly good beside it.
  const payload: GqlPayload = { data: { p0: null, p1: alias({ ...base, number: 9, headRefName: 'feature/b' }) } };
  const prs = decodeRepoBranchPrs(payload, pairs);
  assert.deepEqual(
    prs.map((pr) => [pr.repo, pr.number]),
    [['bigbluedisco/reflow', 9]],
  );
});

test('a branch with no open pull request contributes nothing, and is not an error', () => {
  const payload: GqlPayload = { data: { p0: { pullRequests: { nodes: [] } }, p1: { pullRequests: { nodes: null } } } };
  assert.deepEqual(decodeRepoBranchPrs(payload, pairs), []);
});
