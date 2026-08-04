import type { PlanLimits } from '@fleetwood/core';
import { duration } from './api.ts';

interface Props {
  limits: PlanLimits;
}

/** Warn before the wall, not at it — 75% of a five-hour window is worth seeing. */
function bandOf(utilization: number): string {
  if (utilization >= 0.9) return 'critical';
  if (utilization >= 0.75) return 'warn';
  return '';
}

function resetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return '';
  const seconds = resetsAt - now;
  // A window that should have rolled over already: say so rather than counting
  // backwards, because the next fetch will confirm it.
  return seconds <= 0 ? 'resetting' : `resets ${duration(seconds)}`;
}

/**
 * The Claude plan's quota, as `/usage` shows it.
 *
 * Separate from the cost figures on the rows: those say what the work was worth,
 * this says how much runway is left. An agent can be cheap and still be one turn
 * from stalling for four hours.
 *
 * Attributed to claude explicitly, in the same iris the agent rows use for that
 * tool. A fleet mixing claude with cursor-agent and codex would otherwise read
 * this as a fleet-wide gauge, when it only covers one of them — the others have
 * their own quotas that fleetwood cannot see.
 */
export function LimitBars({ limits }: Props): React.JSX.Element | null {
  if (limits.windows.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="limits">
      <div className="limits-head">
        <span className="tool tool-claude">claude</span>
        <span className="limits-label" title="quota for your Claude plan — cursor and codex have their own, which fleetwood can't read">
          plan usage
        </span>
      </div>
      {limits.windows.map((window) => {
        const percent = Math.round(window.utilization * 100);
        return (
          <div className="limit" key={window.key} title={`${window.title} — ${percent}% used`}>
            <span className="limit-title">{window.title}</span>
            <span className={`limit-track${limits.stale ? ' stale' : ''}`}>
              <span
                className={`limit-fill ${bandOf(window.utilization)}`}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </span>
            <span className="limit-percent">{percent}%</span>
            <span className="limit-reset">{resetLabel(window.resetsAt, now)}</span>
          </div>
        );
      })}
      {/* Claude Code shows an "as of" note rather than an error when the endpoint
          is unavailable; a dated bar still locates you, a missing one does not. */}
      {limits.stale && (
        <div className="limit-stale" title="the usage endpoint did not answer the last poll">
          as of {duration(now - limits.fetchedAt)} ago
        </div>
      )}
    </div>
  );
}
