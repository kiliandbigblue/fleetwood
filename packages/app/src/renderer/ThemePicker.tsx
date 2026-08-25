import { useEffect, useRef } from 'react';
import { THEME_NAMES, THEMES } from '@fleetwood/core/theme';
import type { ThemeName } from '@fleetwood/core/theme';
import { send } from './api.ts';
import { applyTheme } from './theme.ts';

interface Props {
  current: ThemeName;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

/**
 * The theme picker: an icon button in the header, and a popover of flavours.
 *
 * Not a ⌘K entry, even though the palette was the cheaper place to put it: you
 * pick a theme by looking at the panel repaint behind the popover, and a
 * full-screen palette covers the thing you are judging.
 */
export function ThemePicker({ current, open, onToggle, onClose }: Props): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, so a click on any other control closes this before acting.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const choose = (name: ThemeName): void => {
    // Painted here rather than waiting for the snapshot to come back with it: the
    // round trip writes a file, and a picker that lags its own click feels broken.
    // The snapshot is still the source of truth and will agree a moment later.
    applyTheme(name);
    onClose();
    void send({ kind: 'setTheme', theme: name });
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
        className={`icon-button${open ? ' on' : ''}`}
        title={`theme — ${THEMES[current].family} ${THEMES[current].label}`}
        onClick={onToggle}
      >
        ◐
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
        </div>
      )}
    </div>
  );
}
