import { useEffect, useRef, useState } from 'react';
import { MIN_BG_OPACITY, THEME_NAMES, THEMES } from '@fleetwood/core/theme';
import type { ThemeName } from '@fleetwood/core/theme';
import { send } from './api.ts';
import { Icon } from './Icon.tsx';
import { applyTheme } from './theme.ts';
import { useDismiss } from './useDismiss.ts';

interface Props {
  current: ThemeName;
  /** The configured background opacity, 0.2–1. */
  bgOpacity: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

/** Whole percents: the file holds 0.65, the slider speaks 65. */
const PERCENT_STEP = 5;

/**
 * The theme picker: an icon button in the top rail, a popover of flavours, and
 * the background-opacity slider under them.
 *
 * Not a ⌘K entry, even though the palette was the cheaper place to put it: you
 * pick a theme by looking at the panel repaint behind the popover, and a
 * full-screen palette covers the thing you are judging. The slider belongs here
 * for the same reason, and doubly so — it is judged entirely by what shows
 * through, so it has to sit on the surface it is thinning.
 */
export function ThemePicker({
  current,
  bgOpacity,
  open,
  onToggle,
  onClose,
}: Props): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  /*
   * The slider's own position, so a drag is not fighting the 1s snapshot poll.
   * It follows the config whenever that changes — including a hand edit — but a
   * drag in progress leaves the config untouched until the write below settles,
   * so there is nothing to be yanked back to mid-gesture.
   */
  const [alpha, setAlpha] = useState(bgOpacity);
  useEffect(() => setAlpha(bgOpacity), [bgOpacity]);
  const writeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useDismiss(wrapRef, open, onClose);

  const choose = (name: ThemeName): void => {
    // Painted here rather than waiting for the snapshot to come back with it: the
    // round trip writes a file, and a picker that lags its own click feels broken.
    // The snapshot is still the source of truth and will agree a moment later.
    applyTheme(name, alpha);
    onClose();
    void send({ kind: 'setTheme', theme: name });
  };

  /*
   * Repaint on every step, persist once the dragging stops.
   *
   * Same trade as `choose`, one order of magnitude sharper: an opacity you cannot
   * see while you choose it is not a setting you can choose, and a config file
   * rewritten sixty times a second to record a gesture that is still in progress
   * is not one either.
   */
  const slide = (percent: number): void => {
    const value = percent / 100;
    setAlpha(value);
    applyTheme(current, value);
    clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => void send({ kind: 'setBgOpacity', value }), 250);
  };

  // Families in registry order, each with its flavours, so the list groups
  // without the registry having to carry an explicit ordering.
  const families: Array<{ family: string; names: ThemeName[] }> = [];
  for (const name of THEME_NAMES) {
    const { family } = THEMES[name];
    const last = families.at(-1);
    if (last?.family === family) last.names.push(name);
    else families.push({ family, names: [name] });
  }

  return (
    <div className="theme-picker" ref={wrapRef}>
      <button
        className={`icon-button${open ? ' showing' : ''}`}
        title={`theme — ${THEMES[current].family} ${THEMES[current].label}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="contrast" />
      </button>
      {open && (
        <div className="theme-menu">
          {families.map(({ family, names }) => (
            <div key={family}>
              <div className="theme-family">{family}</div>
              {/*
                The name alone. Swatches were here and earned nothing: flavours
                within a family share their accents outright — Main and Moon are
                the same four values — and the background is the only thing that
                really separates them, which is exactly what a row of 7px squares
                cannot show. Applying one is instant, so the panel behind the
                popover is the honest preview.
              */}
              {names.map((name) => (
                <button
                  key={name}
                  className={`theme-option${name === current ? ' on' : ''}`}
                  onClick={() => choose(name)}
                >
                  <span className="theme-label">{THEMES[name].label}</span>
                  <span className="theme-check">{name === current ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          ))}
          {/*
            Last, under a divider: it is the one control here that is not a theme,
            and putting it above the list would push the flavours off the bottom.
          */}
          <div className="theme-alpha">
            <div className="theme-family">
              background
              <span className="theme-alpha-value">{Math.round(alpha * 100)}%</span>
            </div>
            <input
              type="range"
              min={Math.round(MIN_BG_OPACITY * 100)}
              max={100}
              step={PERCENT_STEP}
              value={Math.round(alpha * 100)}
              title="how much of the desktop shows through"
              onChange={(event) => slide(Number(event.target.value))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
