import { useEffect, useState } from 'react';
import { formatCountdown } from '@fleetwood/core/shutdown';
import type { Snapshot } from '../shared/ipc.ts';
import { api, send } from './api.ts';
import { useNow } from './useNow.ts';
import { applyTheme } from './theme.ts';

/**
 * The fifteen-minute warning: the whole primary display, counting down.
 *
 * Its own window rather than a banner in the panel, because the panel is usually
 * hidden and a notice you have to go looking for is not a notice. It covers what
 * you were doing on purpose — the point is that the day is ending and you have to
 * see it — and then it gets out of the way on one key.
 *
 * Dismissing is "I know", not "not tonight": the machine still goes down at the
 * hour, and the rail's power tab keeps counting it. Calling off the evening is a
 * separate act, in a separate place, which is what keeps this button safe to hit
 * without reading.
 */
export function ShutdownWarning(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  useEffect(() => api.onSnapshot(setSnapshot), []);
  useEffect(() => {
    if (snapshot) applyTheme(snapshot.theme, 1);
  }, [snapshot?.theme]);

  // Escape and return both, because this window arrives over whatever you were
  // typing into and the muscle memory for "yes, go away" is one of the two.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      void send({ kind: 'dismissShutdownWarning' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const now = useNow();
  const shutdown = snapshot?.shutdown;
  // Between `loadFile` and the first snapshot there is nothing true to say, and a
  // flash of an empty red screen over your work is worse than a blank frame.
  if (!shutdown?.at) return null;

  const left = Math.max(0, shutdown.at - now);
  return (
    <div className="warning">
      <div className="warning-sheet">
        <div className="warning-kicker">end of day</div>
        <div className="warning-countdown">{formatCountdown(left)}</div>
        <div className="warning-line">this machine shuts down at {shutdown.time}</div>
        <div className="warning-note">save your work</div>
        <button
          className="warning-dismiss"
          onClick={() => void send({ kind: 'dismissShutdownWarning' })}
          autoFocus
        >
          got it <span className="key">esc</span>
        </button>
        {/* Said on the button's own terms, because the button is the one thing
            here anybody reads: this dismisses the notice, not the evening. */}
        <div className="warning-fine">
          the shutdown still happens — call it off in fleetwood’s power tab
        </div>
      </div>
    </div>
  );
}
