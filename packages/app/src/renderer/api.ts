import type { FleetwoodApi } from '../preload/index.ts';
import type { Request, Response } from '../shared/ipc.ts';

declare global {
  interface Window {
    fleetwood: FleetwoodApi;
  }
}

export const api = window.fleetwood;

export function send(request: Request): Promise<Response> {
  return api.invoke(request);
}

/** Local wall clock, 24h, the form both quota readouts use. */
function hhmm(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * When the five-hour window rolls over, as a bare local time.
 *
 * A session window is at most five hours away, so it needs no day: `15:00`
 * is unambiguous, and it is the whole of what the rail has room to say. The
 * dated forms belong to the weekly windows, which `resetClock` handles.
 */
export function resetTime(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return '';
  if (resetsAt - now <= 0) return 'resetting';
  return hhmm(new Date(resetsAt * 1000));
}

/**
 * When a quota window rolls over, as a clock rather than a countdown.
 *
 * The rail already says how full the window is; a second duration (`3h21m`)
 * next to a percent is two ways of saying "soon". The time of day is the fact
 * that changes what you do — stop at 17:40, or keep going. A weekly window
 * lands days out, so this one names the day it lands on.
 */
export function resetClock(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return '';
  if (resetsAt - now <= 0) return 'resetting';
  const at = new Date(resetsAt * 1000);
  const time = hhmm(at);
  const today = new Date(now * 1000);
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(today)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) {
    const weekday = at.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Human-readable elapsed time, matching the CLI's format. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  // Roll over to days, or a PR untouched for a week reads as "167h59m".
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
}

export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

/**
 * Shorten a path from the middle, keeping both ends readable.
 *
 * The tail is the part that identifies a worktree, and the head says whether it's
 * under ~/projects at all — so an end-ellipsis loses the useful half. Doing this
 * in JS rather than with `direction: rtl`, which visually reorders an all-LTR
 * string and renders `~/projects/fleetwood` as `projects/fleetwood/~`.
 */
export function shortenPath(path: string, max = 30): string {
  const text = tildify(path);
  if (text.length <= max) return text;
  const segments = text.split('/');
  if (segments.length <= 2) return `…${text.slice(-(max - 1))}`;
  // Keep as many trailing segments as fit, always prefixed with an ellipsis.
  const kept: string[] = [];
  let length = 1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] as string;
    if (length + segment.length + 1 > max && kept.length > 0) break;
    kept.unshift(segment);
    length += segment.length + 1;
  }
  const joined = `…/${kept.join('/')}`;
  // A single segment can be longer than the whole budget (branch-derived worktree
  // names are), and leaving it to CSS produces a second ellipsis on the same line.
  return joined.length <= max ? joined : `…${joined.slice(-(max - 1))}`;
}

export function relativeIso(iso: string): string {
  if (!iso) return '';
  const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  return `${duration(seconds)} ago`;
}
