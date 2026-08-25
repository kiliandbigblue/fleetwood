import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_NAMES,
  isThemeName,
  paletteFor,
  rgbTriplet,
  type Palette,
} from '../src/theme.ts';

/**
 * Every role, listed here rather than derived from a theme — otherwise a palette
 * that forgot a colour would set the expectation instead of failing it.
 */
const ROLES: Array<keyof Palette> = [
  'bg',
  'panel',
  'edge',
  'dim',
  'soft',
  'text',
  'danger',
  'warn',
  'ok',
  'accent',
  'branch',
];

test('every theme fills every role with a 6-digit hex', () => {
  for (const name of THEME_NAMES) {
    const { palette } = THEMES[name];
    assert.deepEqual(
      Object.keys(palette).sort(),
      [...ROLES].sort(),
      `${name} does not fill exactly the eleven roles`,
    );
    for (const role of ROLES) {
      assert.match(palette[role], /^#[0-9a-f]{6}$/, `${name}.${role} is not a lowercase hex colour`);
    }
  }
});

test('no theme paints text in its own background', () => {
  // A cheap smoke test for a transcription slip: any palette where the text and
  // the surface it sits on are the same colour is unusable, whatever it looks
  // like in the picker.
  for (const name of THEME_NAMES) {
    const { palette } = THEMES[name];
    assert.notEqual(palette.text, palette.bg, `${name} text is invisible on bg`);
    assert.notEqual(palette.text, palette.panel, `${name} text is invisible on panel`);
    assert.notEqual(palette.bg, palette.panel, `${name} cards do not lift off the window`);
  }
});

test('the default theme is the Rose Pine the panel used to hardcode', () => {
  // The regression guard on the rename: an install that never sets `theme` must
  // come up in exactly the colours it had before themes existed.
  assert.equal(DEFAULT_THEME, 'rose-pine');
  assert.deepEqual(THEMES[DEFAULT_THEME].palette, {
    bg: '#191724',
    panel: '#1f1d2e',
    edge: '#26233a',
    dim: '#6e6a86',
    soft: '#908caa',
    text: '#e0def4',
    danger: '#eb6f92',
    warn: '#f6c177',
    ok: '#9ccfd8',
    accent: '#c4a7e7',
    branch: '#ebbcba',
  });
});

test('themes are grouped by family in listing order', () => {
  // The picker groups by walking the list and starting a heading whenever the
  // family changes, so a family split across the order would render twice.
  const seen = new Set<string>();
  let previous = '';
  for (const name of THEME_NAMES) {
    const { family } = THEMES[name];
    if (family !== previous) {
      assert.ok(!seen.has(family), `${family} appears in two runs of the list`);
      seen.add(family);
      previous = family;
    }
  }
});

test('isThemeName rejects anything not in the registry', () => {
  assert.ok(isThemeName('catppuccin-mocha'));
  assert.ok(!isThemeName('catppuccin'));
  assert.ok(!isThemeName('Catppuccin Mocha'));
  assert.ok(!isThemeName(undefined));
  assert.ok(!isThemeName(42));
});

test('paletteFor falls back rather than throwing on a hand-edited name', () => {
  assert.equal(paletteFor('tokyonight-moon').bg, '#1e2030');
  assert.deepEqual(paletteFor('tokyonite'), THEMES[DEFAULT_THEME].palette);
  assert.deepEqual(paletteFor(undefined), THEMES[DEFAULT_THEME].palette);
});

test('rgbTriplet renders the CLI escape operands', () => {
  assert.equal(rgbTriplet('#000000'), '0;0;0');
  assert.equal(rgbTriplet('#ffffff'), '255;255;255');
  assert.equal(rgbTriplet('#eb6f92'), '235;111;146');
  // The values the CLI used to carry literally, so the escapes are unchanged.
  assert.equal(rgbTriplet('#f6c177'), '246;193;119');
  assert.equal(rgbTriplet('#9ccfd8'), '156;207;216');
  assert.equal(rgbTriplet('#c4a7e7'), '196;167;231');
  assert.equal(rgbTriplet('#6e6a86'), '110;106;134');
  assert.throws(() => rgbTriplet('eb6f92'), /not a 6-digit hex/);
  assert.throws(() => rgbTriplet('#fff'), /not a 6-digit hex/);
});
