import { useCallback, useRef, useState } from 'react';
import type { FleetState, LimitWindow, PlanLimits } from '@fleetwood/core';
import { duration, money } from './api.ts';
import { useDismiss } from './useDismiss.ts';

interface Props {
  counts: FleetState['counts'];
  /** Absent unless `limits.tokenCommand` is configured. */
  limits?: PlanLimits;
}

/** Warn before the wall, not at it — 75% of a five-hour window is worth seeing. */
function bandOf(utilization: number): string {
  if (utilization >= 0.9) return 'critical';
  if (utilization >= 0.75) return 'warn';
  return '';
}

/**
 * When the window rolls over.
 *
 * `bare` for the rail, which has room for `2h14m` and not for the verb, and whose
 * tooltip spells it out anyway; the popover rows have the room and say `resets`.
 */
function resetLabel(resetsAt: number | undefined, now: number, bare = false): string {
  if (resetsAt === undefined) return '';
  const seconds = resetsAt - now;
  // A window that should have rolled over already: say so rather than counting
  // backwards, because the next fetch will confirm it.
  if (seconds <= 0) return 'resetting';
  return bare ? duration(seconds) : `resets ${duration(seconds)}`;
}

/**
 * The window closest to stopping you.
 *
 * Not the first one. The rail has room for a single gauge, and the five-hour
 * window is only the interesting one until the weekly cap gets ahead of it — at
 * which point showing the session's 20% while the week sits at 94% is a gauge
 * that reads green right up to the stall. Ties keep the endpoint's order, which
 * puts the session window first.
 */
function binding(windows: LimitWindow[]): LimitWindow | undefined {
  return windows.reduce<LimitWindow | undefined>(
    (worst, window) => (worst && worst.utilization >= window.utilization ? worst : window),
    undefined,
  );
}

function Meter({ utilization, stale }: { utilization: number; stale?: boolean }): React.JSX.Element {
  const percent = Math.round(utilization * 100);
  return (
    <span className={`meter${stale ? ' stale' : ''}`}>
      <span
        className={`meter-fill ${bandOf(utilization)}`}
        style={{ width: `${Math.max(2, percent)}%` }}
      />
    </span>
  );
}

/**
 * The plan quota, as one gauge that expands into all of them.
 *
 * It used to be every window at once, stacked — six rows of title, bar, percent
 * and reset, pinned under the fleet and taller than most of the cards it was
 * supposed to be annotating. This is runway, not work: it earns a glance a few
 * times a day and a proper read almost never, so it gets a line and a popover
 * rather than a table.
 */
function Quota({ limits }: { limits: PlanLimits }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, open, close);

  const worst = binding(limits.windows);
  if (!worst) return null;
  const now = Math.floor(Date.now() / 1000);
  const percent = Math.round(worst.utilization * 100);

  return (
    <div className="quota" ref={wrapRef}>
      <button
        className={`quota-gauge${open ? ' showing' : ''}`}
        title={[
          `${worst.title} — ${percent}% used`,
          resetLabel(worst.resetsAt, now),
          limits.stale ? `as of ${duration(now - limits.fetchedAt)} ago` : '',
        ]
          .filter(Boolean)
          .join(', ')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {/*
          Attributed to claude explicitly, in the same accent the agent rows use
          for that tool. A fleet mixing claude with cursor-agent and codex would
          otherwise read this as a fleet-wide gauge, when it only covers one of
          them — the others have their own quotas that fleetwood cannot see.
        */}
        <span className="tool tool-claude">claude</span>
        <span className="quota-window">{worst.short}</span>
        <Meter utilization={worst.utilization} stale={limits.stale} />
        <span className="quota-percent">{percent}%</span>
        <span className="quota-reset">{resetLabel(worst.resetsAt, now, true)}</span>
      </button>

      {open && (
        <div className="quota-menu">
          <div className="quota-menu-head">plan usage</div>
          {limits.windows.map((window) => (
            <div className="quota-row" key={window.key}>
              <span className="quota-row-title">{window.title}</span>
              <Meter utilization={window.utilization} stale={limits.stale} />
              <span className="quota-percent">{Math.round(window.utilization * 100)}%</span>
              <span className="quota-reset">{resetLabel(window.resetsAt, now)}</span>
            </div>
          ))}
          {/* Claude Code shows an "as of" note rather than an error when the
              endpoint is unavailable; a dated bar still locates you, a missing one
              does not. */}
          {limits.stale && (
            <div className="quota-stale" title="the usage endpoint did not answer the last poll">
              as of {duration(now - limits.fetchedAt)} ago
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The bottom rail: what the fleet is doing, and how much runway is left.
 *
 * The counterweight to the top rail. Up there is everything that is waiting on
 * you and every way to get to it; down here is everything that is merely true —
 * ambient, never actionable, and so never in the way of the list between them.
 * That split is why `blocked` moved up out of this row and `working`, `idle` and
 * the fleet's spend moved down into it.
 *
 * `working` and `idle` do not have to add up to the fleet: `starting` and
 * `compacting` are real states that pass too quickly to be worth a word here, and
 * the rows below always have the full account.
 */
export function StatusBar({ counts, limits }: Props): React.JSX.Element {
  return (
    <footer className="rail rail-bottom">
      <div className="vitals">
        {counts.working > 0 && (
          <span className="vital ok" title={`${counts.working} mid-turn`}>
            <span className="dot pulsing" />
            {counts.working} working
          </span>
        )}
        <span
          className="vital"
          title={
            counts.total === 0
              ? 'no agents registered'
              : `${counts.idle} registered and awaiting a prompt`
          }
        >
          {counts.total === 0 ? 'no agents' : `${counts.idle} idle`}
        </span>
        {counts.costUsd > 0 && (
          <span className="vital" title="what the whole fleet has spent, estimated at API rates">
            {money(counts.costUsd)}
          </span>
        )}
      </div>
      {limits && <Quota limits={limits} />}
    </footer>
  );
}
