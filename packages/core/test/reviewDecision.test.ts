import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveReviewDecision } from '../src/github.ts';

test('a re-requested review clears a stale changes-requested decision', () => {
  // What GitHub hands back after the author re-requests the reviewer who asked
  // for changes: the decision is unchanged, but that review has left
  // `latestReviews` because it is no longer current.
  assert.equal(effectiveReviewDecision('CHANGES_REQUESTED', []), 'REVIEW_REQUIRED');
  assert.equal(
    effectiveReviewDecision('CHANGES_REQUESTED', [{ state: 'COMMENTED' }]),
    'REVIEW_REQUIRED',
  );
});

test('changes requested stands while the review is still current', () => {
  assert.equal(
    effectiveReviewDecision('CHANGES_REQUESTED', [{ state: 'COMMENTED' }, { state: 'CHANGES_REQUESTED' }]),
    'CHANGES_REQUESTED',
  );
});

test('every other decision passes through', () => {
  // An approval is not weakened by a re-request, and a missing decision is not
  // turned into one.
  assert.equal(effectiveReviewDecision('APPROVED', []), 'APPROVED');
  assert.equal(effectiveReviewDecision('REVIEW_REQUIRED', []), 'REVIEW_REQUIRED');
  assert.equal(effectiveReviewDecision(undefined, undefined), undefined);
  assert.equal(effectiveReviewDecision('', []), '');
});
