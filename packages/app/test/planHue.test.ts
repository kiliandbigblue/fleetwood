import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHue, ticketCardStyle } from '../src/renderer/planHue.ts';

test("a plan's hue is a degree on the wheel, the same every time", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `milestone-${i}`);
  for (const id of ids) {
    assert.equal(planHue(id), planHue(id));
    assert.ok(planHue(id) >= 0 && planHue(id) < 360);
  }
  // Ids a character apart do not bunch up on one stretch of the wheel.
  assert.ok(new Set(ids.map((id) => Math.floor(planHue(id) / 30))).size >= 10);
});

test("a card's tickets take evenly spaced turns, whatever their ids hash to", () => {
  const style = ticketCardStyle(['DEV-1865', 'DEV-1866', 'DEV-1867', 'DEV-1868'], ['atlas', 'graphy']);
  // Sorted, so the lowest id is unturned and wears the accent.
  assert.equal(style['--ticket-DEV-1865'], 0);
  assert.equal(style['--ticket-DEV-1866'], 90);
  assert.equal(style['--ticket-DEV-1867'], 180);
  assert.equal(style['--ticket-DEV-1868'], 270);
  assert.equal(style['--repo-ch'], 6);
});

test('a card working one ticket leaves its chip uncoloured', () => {
  assert.deepEqual(ticketCardStyle(['DEV-1873'], []), { '--repo-ch': 0 });
});
