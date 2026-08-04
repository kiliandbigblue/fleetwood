import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchToSlug, buildBranch, slugify } from '../src/task.ts';

test('branch names follow the <type>/<microservice>-<summary> convention', () => {
  // The microservice is a domain, not a repo — which is why the same branch name
  // gets reused in every repo the change touches.
  assert.equal(buildBranch('fix', 'flow', 'execution labels'), 'fix/flow-execution-labels');
  assert.equal(
    buildBranch('feature', 'merchantportal', 'packaging search index'),
    'feature/merchantportal-packaging-search-index',
  );
  assert.equal(buildBranch('chore', 'ui', 'tokens page'), 'chore/ui-tokens-page');
});

test('branch building tolerates messy input', () => {
  assert.equal(buildBranch('Fix', 'Flow', 'Execution  Labels!'), 'fix/flow-execution-labels');
  assert.equal(buildBranch('feature', 'flow', 'add "pick" variable'), 'feature/flow-add-pick-variable');
  // An accented summary must still produce a valid git ref.
  assert.equal(buildBranch('fix', 'mrw', 'césar observaciones'), 'fix/mrw-cesar-observaciones');
});

test('a missing type falls back rather than producing a bare slug', () => {
  assert.equal(buildBranch('', 'flow', 'labels'), 'feature/flow-labels');
});

test('a missing microservice still yields a usable branch', () => {
  assert.equal(buildBranch('fix', '', 'stray whitespace'), 'fix/stray-whitespace');
});

test('slugify produces valid git ref components', () => {
  const nasty = 'Feature: add ~caret^ and [bracket] and ..dots.. and a\\backslash';
  const slug = slugify(nasty);
  // git check-ref-format rejects all of these; none may survive.
  for (const bad of ['~', '^', ':', '?', '*', '[', ']', '\\', '..', ' ']) {
    assert.ok(!slug.includes(bad), `${bad} survived slugify: ${slug}`);
  }
  assert.ok(!slug.startsWith('-') && !slug.endsWith('-'));
});

test('slugify is bounded so paths and refs stay sane', () => {
  assert.ok(slugify('a'.repeat(200)).length <= 60);
});

test('the task folder name is the branch without its type prefix', () => {
  assert.equal(branchToSlug('fix/flow-execution-labels'), 'flow-execution-labels');
  assert.equal(branchToSlug('feature/merchantportal-packaging'), 'merchantportal-packaging');
  // A branch with no type prefix is still usable.
  assert.equal(branchToSlug('hotfix-now'), 'hotfix-now');
  // Only the first segment is the type; the rest keeps its shape.
  assert.equal(branchToSlug('feature/DEV-1189/partial-modal'), 'dev-1189-partial-modal');
});

test('slug and branch round-trip for the same task description', () => {
  const branch = buildBranch('fix', 'flow', 'execution labels');
  assert.equal(branchToSlug(branch), 'flow-execution-labels');
  // Rebuilding from the same inputs is stable — that is what makes createTask
  // idempotent by slug.
  assert.equal(buildBranch('fix', 'flow', 'execution labels'), branch);
});
