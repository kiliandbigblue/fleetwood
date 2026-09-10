import { useCallback, useRef, useState } from 'react';
import type { CursorUsage, FleetState, LimitWindow, PlanLimits } from '@fleetwood/core';
import { duration, resetClock } from './api.ts';
import { useDismiss } from './useDismiss.ts';

interface Props {
  counts: FleetState['counts'];
  /** Absent unless `limits.tokenCommand` is configured. */
  limits?: PlanLimits;
  /** Absent unless `limits.cursorTokenCommand` is configured. */
  cursorUsage?: CursorUsage;
}

/** Warn before the wall, not at it — 75% of a five-hour window is worth seeing. */
function bandOf(utilization: number): string {
  if (utilization >= 0.9) return 'critical';
  if (utilization >= 0.75) return 'warn';
  return '';
}

function usd(cents: number): string {
  const dollars = Math.round(cents) / 100;
  return Number.isInteger(dollars) ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
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
 * The window closest to stopping you.
 *
 * Not the first one. The rail has room for a single gauge, and the five-hour
 * window is only the interesting one until the weekly cap gets ahead of it.
 */
function binding(windows: LimitWindow[]): LimitWindow | undefined {
  return windows.reduce<LimitWindow | undefined>(
    (worst, window) => (worst && worst.utilization >= window.utilization ? worst : window),
    undefined,
  );
}

/**
 * Claude: how full, and what time the window ends.
 *
 * The window's name (`5h`) and a countdown (`3h21m`) both restated the same
 * fact. The bar plus a percent is the fill; a clock is when it opens again.
 */
function ClaudeQuota({ limits }: { limits: PlanLimits }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, open, close);

  const worst = binding(limits.windows);
  if (!worst) return null;
  const now = Math.floor(Date.now() / 1000);
  const percent = Math.round(worst.utilization * 100);
  const clock = resetClock(worst.resetsAt, now);

  const extra = limits.windows.filter((window) => window.key !== worst.key);
  const hasMenu = extra.length > 0 || Boolean(limits.stale);

  return (
    <div className="quota" ref={wrapRef}>
      <button
        className={`quota-gauge${open ? ' showing' : ''}`}
        title={[
          `${worst.title} — ${percent}% used`,
          clock ? `resets ${clock}` : '',
          limits.stale ? `as of ${duration(now - limits.fetchedAt)} ago` : '',
        ]
          .filter(Boolean)
          .join(', ')}
        aria-expanded={hasMenu ? open : undefined}
        onClick={() => {
          if (hasMenu) setOpen((value) => !value);
        }}
      >
        <span className="tool tool-claude">claude</span>
        <Meter utilization={worst.utilization} stale={limits.stale} />
        <span className="quota-fig">{percent}%</span>
        {clock && <span className="quota-sub">{clock}</span>}
      </button>

      {open && hasMenu && (
        <div className="quota-menu">
          {extra.map((window) => (
            <div className="quota-row" key={window.key}>
              <span className="quota-row-title">{window.short}</span>
              <Meter utilization={window.utilization} stale={limits.stale} />
              <span className="quota-fig">{Math.round(window.utilization * 100)}%</span>
              <span className="quota-sub">{resetClock(window.resetsAt, now)}</span>
            </div>
          ))}
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
 * Cursor: what this seat has billed this cycle, and what it billed today.
 *
 * Included is always spent by mid-cycle on this plan, so a 100% bar would sit
 * there every day saying nothing. On-demand dollars are the number that moves.
 */
function CursorQuota({ usage }: { usage: CursorUsage }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, open, close);

  const now = Math.floor(Date.now() / 1000);
  const today = usage.todayCents === undefined ? '—' : usd(usage.todayCents);
  const seat = usd(usage.seatCents);

  return (
    <div className="quota" ref={wrapRef}>
      <button
        className={`quota-gauge${open ? ' showing' : ''}`}
        title={[
          `this cycle ${seat}`,
          `today ${today}`,
          usage.stale ? `as of ${duration(now - usage.fetchedAt)} ago` : '',
        ]
          .filter(Boolean)
          .join(', ')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool tool-cursor">cursor</span>
        <span className="quota-fig">{seat}</span>
        <span className="quota-sub">{today}</span>
      </button>

      {open && (
        <div className="quota-menu">
          <div className="quota-row">
            <span className="quota-row-title">cycle</span>
            <span className="quota-row-value">{seat}</span>
          </div>
          <div className="quota-row">
            <span className="quota-row-title">today</span>
            <span className="quota-row-value">{today}</span>
          </div>
          {usage.stale && (
            <div className="quota-stale" title="the usage endpoint did not answer the last poll">
              as of {duration(now - usage.fetchedAt)} ago
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
 */
export function StatusBar({ counts, limits, cursorUsage }: Props): React.JSX.Element {
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
      </div>
      <div className="quotas">
        {limits && <ClaudeQuota limits={limits} />}
        {cursorUsage && <CursorQuota usage={cursorUsage} />}
      </div>
    </footer>
  );
}
