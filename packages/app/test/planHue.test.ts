import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHue } from '../src/renderer/planHue.ts';

test("a plan's hue is a degree on the wheel, the same every time", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `milestone-${i}`);
  for (const id of ids) {
    assert.equal(planHue(id), planHue(id));
    assert.ok(planHue(id) >= 0 && planHue(id) < 360);
  }
  // Ids a character apart do not bunch up on one stretch of the wheel.
  assert.ok(new Set(ids.map((id) => Math.floor(planHue(id) / 30))).size >= 10);
});
