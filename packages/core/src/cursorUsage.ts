import { run } from './exec.ts';
import { extractToken } from './limits.ts';

/**
 * Cursor plan usage for one billing cycle.
 *
 * Distinct from Claude's rolling windows, and from provider bonus credits —
 * bonus is real usage Cursor does not bill, so it is not a number that changes
 * what you do next. What does: how much of the included allotment is left, what
 * this seat has drawn from on-demand so far this cycle, and what it drew today.
 */
export interface CursorUsage {
  /** 0..1 of the included dollar allotment (`$20` on a Team seat). */
  includedUtilization: number;
  includedSpendCents: number;
  includedLimitCents: number;
  /**
   * On-demand billed to this seat this cycle, in cents.
   *
   * `spendLimitUsage.individualUsed` — not `planUsage.totalSpend` (that folds in
   * bonus) and not the team pool.
   */
  seatCents: number;
  /**
   * On-demand billed today (local midnight → now), in cents.
   *
   * Absent when the events call failed: a missing today is better than `$0`,
   * which would read as "you spent nothing".
   */
  todayCents?: number;
  /** Epoch seconds when the billing cycle rolls. */
  resetsAt?: number;
  fetchedAt: number;
  stale?: boolean;
}

const PERIOD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const EVENTS_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents';
const FETCH_TIMEOUT_MS = 5_000;
const USAGE_BASED = /USAGE_BASED/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cents(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 32_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return epochMs(n);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

function fraction(spend: number, limit: number, percentUsed: unknown): number {
  if (limit > 0) return Math.min(1, Math.max(0, spend / limit));
  if (typeof percentUsed === 'number' && Number.isFinite(percentUsed)) {
    return Math.min(1, Math.max(0, percentUsed / 100));
  }
  return 0;
}

/**
 * Shape `GetCurrentPeriodUsage` into included + seat. Bonus is ignored on
 * purpose: it is not billed, and surfacing it next to seat cost is how those
 * two numbers get confused.
 */
export function parseCursorPeriod(body: unknown, now: number): CursorUsage | undefined {
  const root = asRecord(body);
  const plan = asRecord(root?.planUsage);
  if (!plan) return undefined;

  const includedLimitCents = cents(plan.limit) ?? 0;
  const includedSpendCents = cents(plan.includedSpend) ?? 0;
  const spend = asRecord(root?.spendLimitUsage);
  const seatCents = cents(spend?.individualUsed) ?? 0;

  return {
    includedUtilization: fraction(includedSpendCents, includedLimitCents, plan.totalPercentUsed),
    includedSpendCents,
    includedLimitCents,
    seatCents,
    resetsAt: epochMs(root?.billingCycleEnd),
    fetchedAt: now,
  };
}

/**
 * Sum on-demand cents from `GetFilteredUsageEvents`.
 *
 * Included-in-business rows carry a retail `chargedCents` that is not billed;
 * only usage-based chargeable rows hit the seat.
 */
export function sumOnDemandCents(events: unknown): number {
  if (!Array.isArray(events)) return 0;
  let total = 0;
  for (const entry of events) {
    const event = asRecord(entry);
    if (!event) continue;
    if (event.isChargeable === false) continue;
    if (!USAGE_BASED.test(String(event.kind ?? ''))) continue;
    total += cents(event.chargedCents) ?? 0;
  }
  return total;
}

/** Seat and today, as billed: cents when they exist, whole dollars when they don't. */
export function formatUsd(centsValue: number): string {
  const dollars = Math.round(centsValue) / 100;
  if (Number.isInteger(dollars)) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTodayCents(token: string, nowMs: number): Promise<number | undefined> {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const events: unknown[] = [];
  let page = 1;
  let expected: number | undefined;
  while (page <= 20) {
    const body = await postJson(EVENTS_URL, token, {
      startDate: String(start.getTime()),
      endDate: String(nowMs),
      page,
      pageSize: 1000,
    });
    const root = asRecord(body);
    if (!root) return undefined;
    if (expected === undefined) {
      const count = root.totalUsageEventsCount;
      expected = typeof count === 'number' && Number.isFinite(count) ? count : 0;
    }
    const batch = Array.isArray(root.usageEventsDisplay) ? root.usageEventsDisplay : [];
    events.push(...batch);
    if (events.length >= expected || batch.length < 1000) break;
    page += 1;
  }
  return sumOnDemandCents(events);
}

export interface CursorUsageOptions {
  /**
   * Shell command printing the Cursor access token (bare JWT, or JSON holding
   * `accessToken`). Same contract as Claude's `tokenCommand`: fleetwood does not
   * scrape Keychain itself.
   */
  tokenCommand?: string;
  now?: number;
}

/**
 * Fetch included / seat / today. Undefined on every failure path — no command,
 * no token, a network error, a payload that no longer parses. Decoration on a
 * tmux panel; it must never be able to take that panel down.
 */
export async function fetchCursorUsage(options: CursorUsageOptions): Promise<CursorUsage | undefined> {
  const command = options.tokenCommand?.trim();
  if (!command) return undefined;
  const nowMs = options.now ?? Date.now();
  const now = Math.floor(nowMs / 1000);

  const printed = await run('/bin/sh', ['-c', command], { timeoutMs: FETCH_TIMEOUT_MS });
  if (printed.code !== 0) return undefined;
  const token = extractToken(printed.stdout);
  if (!token) return undefined;

  const period = parseCursorPeriod(await postJson(PERIOD_URL, token, {}), now);
  if (!period) return undefined;

  period.todayCents = await fetchTodayCents(token, nowMs);
  return period;
}
