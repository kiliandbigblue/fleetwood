import { useCallback, useRef, useState } from 'react';
import type { CursorUsage, FleetState, LimitWindow, PlanLimits } from '@fleetwood/core';
import { duration, resetClock, resetTime } from './api.ts';
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
 * The five-hour session window — the gauge's one subject.
 *
 * The rail used to show whichever window was fullest, which made the figure
 * anonymous: `4%` with nothing to say it was the week, sitting above a popover
 * listing every window *except* the one being shown. The session window is the
 * one that moves while you work, so the rail holds it and only it, and every
 * other window is in the popover where its name is beside it.
 */
function session(windows: LimitWindow[]): LimitWindow | undefined {
  return windows.find((window) => window.key === 'five_hour');
}

/**
 * The popover's rows: the week, then each model's own cap.
 *
 * In that order because they are different things — `week` is one pool shared
 * across models, and a model row is a cap you can walk away from by switching
 * model. Within the model rows, fullest first; that is the only ordering that
 * survives a plan gaining or losing a family.
 */
function weeklyRows(windows: LimitWindow[]): LimitWindow[] {
  const rest = windows.filter((window) => window.key !== 'five_hour');
  const all = rest.filter((window) => window.key === 'seven_day');
  const perModel = rest
    .filter((window) => window.key !== 'seven_day')
    .sort((a, b) => b.utilization - a.utilization);
  return [...all, ...perModel];
}

/**
 * Claude: how full the session window is, and what time it resets.
 *
 * The window's name (`5h`) and a countdown (`3h21m`) both restated the same
 * fact. The bar plus a percent is the fill; a clock is when it opens again.
 */
function ClaudeQuota({ limits }: { limits: PlanLimits }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, open, close);

  if (limits.windows.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const current = session(limits.windows);
  const percent = current ? Math.round(current.utilization * 100) : undefined;
  const clock = resetTime(current?.resetsAt, now);

  const rows = weeklyRows(limits.windows);
  const hasMenu = rows.length > 0 || Boolean(limits.stale);

  return (
    <div className="quota" ref={wrapRef}>
      <button
        className={`quota-gauge${open ? ' showing' : ''}`}
        title={[
          current ? `${current.title} — ${percent}% used` : 'no session window reported',
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
        {current ? (
          <>
            <Meter utilization={current.utilization} stale={limits.stale} />
            <span className="quota-fig">{percent}%</span>
            {clock && <span className="quota-sub">{clock}</span>}
          </>
        ) : (
          /* The endpoint answered without a session window. The weekly list is
             still worth opening, so the gauge stays clickable and says nothing
             rather than promoting another window into a slot that names none. */
          <span className="quota-fig">—</span>
        )}
      </button>

      {open && hasMenu && (
        <div className="quota-menu quota-windows">
          {rows.map((window) => (
            <div className="quota-row" key={window.key}>
              <span className="quota-row-title" title={window.title}>
                {window.short}
              </span>
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
