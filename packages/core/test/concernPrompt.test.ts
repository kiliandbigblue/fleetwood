import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concernPrompt } from '../src/tour.ts';

test('a raised question carries what was asked and what the agent answered', () => {
  const prompt = concernPrompt(
    [
      {
        path: 'retry.go',
        line: 22,
        side: 'new',
        code: 'return errors.Join(err, ctx.Err())',
        body: 'Use %w twice instead.',
        asked: { question: 'Why errors.Join?', answer: 'It keeps both errors matchable (retry.go:22).' },
      },
      { path: 'retry.go', line: 26, side: 'new', code: '', body: 'fmt is not imported.' },
    ],
    '/w',
    '/w',
  );
  assert.match(prompt, /Use %w twice instead\.\n\nBefore raising this, the reviewer asked: Why errors\.Join\?\nAn agent reading the code answered: It keeps both/);
  // A plain concern says only what the reviewer wrote.
  assert.match(prompt, /## retry\.go:26\nfmt is not imported\.$/);
});
