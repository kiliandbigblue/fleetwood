import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BG_OPACITY,
  DEFAULT_THEME,
  MIN_BG_OPACITY,
  clampBgOpacity,
  withAlpha,
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
  assert.ok(isThemeName('helldivers-ii'));
  assert.ok(!isThemeName('catppuccin'));
  assert.ok(!isThemeName('Catppuccin Mocha'));
  assert.ok(!isThemeName('helldivers'));
  assert.ok(!isThemeName(undefined));
  assert.ok(!isThemeName(42));
});

test('helldivers-ii is the companion-site yellow on near-black', () => {
  const theme = THEMES['helldivers-ii'];
  assert.equal(theme.family, 'Helldivers II');
  assert.equal(theme.palette.accent, '#ffe710');
  assert.equal(theme.palette.bg, '#080808');
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

test('the default background opacity is opaque', () => {
  // The regression guard on the slider: an install that never touches it must
  // look exactly as it did before the window could be seen through.
  assert.equal(DEFAULT_BG_OPACITY, 1);
  assert.equal(clampBgOpacity(undefined), 1);
});

test('clampBgOpacity keeps a hand-edited opacity inside the slider range', () => {
  assert.equal(clampBgOpacity(0.65), 0.65);
  assert.equal(clampBgOpacity(1), 1);
  assert.equal(clampBgOpacity(MIN_BG_OPACITY), MIN_BG_OPACITY);
  // Above solid, and below the floor where the panel stops being readable.
  assert.equal(clampBgOpacity(4), 1);
  assert.equal(clampBgOpacity(0), MIN_BG_OPACITY);
  assert.equal(clampBgOpacity(-1), MIN_BG_OPACITY);
  // The shapes a hand-edit produces: a percentage as a string, a null, a NaN.
  for (const bad of ['0.5', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(clampBgOpacity(bad), DEFAULT_BG_OPACITY, `${JSON.stringify(bad)} should fall back`);
  }
});

test('withAlpha renders the translucent surfaces the renderer paints', () => {
  assert.equal(withAlpha('#191724', 1), 'rgb(25 23 36 / 1)');
  assert.equal(withAlpha('#1f1d2e', 0.6), 'rgb(31 29 46 / 0.6)');
  // Clamped on the way out too, so no caller can paint an invisible window.
  assert.equal(withAlpha('#000000', 0), `rgb(0 0 0 / ${MIN_BG_OPACITY})`);
  assert.throws(() => withAlpha('#fff', 1), /not a 6-digit hex/);
});
