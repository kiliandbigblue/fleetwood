import { run } from './exec.ts';

/**
 * Plan quota, as Claude Code's own `/usage` screen shows it.
 *
 * Distinct from token spend: `usage.ts` answers "what did this agent cost",
 * this answers "how much of the subscription window is left". A fleet can be
 * cheap in dollars and still be about to stall at 100% of a five-hour window.
 */
export interface LimitWindow {
  /** Wire key: `five_hour`, `seven_day`, `seven_day_sonnet`, … */
  key: string;
  /** "Current session", "Current week (all models)", … */
  title: string;
  /** 0..1. */
  utilization: number;
  /** Epoch seconds, or undefined when the window carries no reset. */
  resetsAt?: number;
}

export interface PlanLimits {
  windows: LimitWindow[];
  /** Epoch seconds when this was fetched. */
  fetchedAt: number;
  /**
   * The last fetch failed and these are the previous numbers.
   *
   * Shown with an "as of" note rather than hidden: a stale bar still tells you
   * roughly where you stand, and a blank panel tells you nothing.
   */
  stale?: boolean;
}

/** Titles Claude Code uses, so the panel and `/usage` agree. */
const TITLES: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_sonnet: 'Current week (Sonnet only)',
  seven_day_opus: 'Current week (Opus only)',
  seven_day_overage_included: 'Current week (Fable 5)',
  overage: 'Usage credits',
};

/** The order the bars should read in, coarsest window last. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];

/**
 * Utilization as a 0..1 fraction, which is what the endpoint reports.
 *
 * No "looks like a percentage" rescaling: `1.4` is 140% of a blown limit, not
 * 1.4%, and nothing in the payload distinguishes those two readings. Guessing
 * would silently mis-scale a real bar by 100×; clamping means that if the wire
 * format ever does change to 0..100, every bar pins at full and someone notices.
 */
function fraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function epoch(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds — anything past year 3000 is the latter.
    return value > 32_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

interface WireWindow {
  utilization?: unknown;
  percent?: unknown;
  resets_at?: unknown;
}

/**
 * Shape the `/api/oauth/usage` response into bars.
 *
 * Total and permissive on purpose: this is an internal endpoint that can change
 * shape without notice, and a new key must leave the rest of the panel standing
 * rather than take it down. Unknown keys are surfaced with their raw name so a
 * new window still shows up, just without a friendly title.
 */
export function parseLimits(body: unknown, now: number): PlanLimits {
  const root = (body ?? {}) as Record<string, unknown>;
  const windows: LimitWindow[] = [];

  const push = (key: string, wire: WireWindow, title?: string): void => {
    const utilization = fraction(wire.utilization ?? wire.percent);
    if (utilization === undefined) return;
    windows.push({
      key,
      title: title ?? TITLES[key] ?? key.replace(/_/g, ' '),
      utilization,
      resetsAt: epoch(wire.resets_at),
    });
  };

  for (const [key, value] of Object.entries(root)) {
    if (key === 'limits' || value === null || typeof value !== 'object') continue;
    push(key, value as WireWindow);
  }

  // Per-model weekly windows arrive as a list rather than named keys.
  const scoped = root.limits;
  if (Array.isArray(scoped)) {
    for (const entry of scoped as Record<string, unknown>[]) {
      const scope = entry.scope as { model?: { display_name?: unknown } } | undefined;
      const name = scope?.model?.display_name;
      if (typeof name !== 'string') continue;
      push(`weekly_scoped:${name}`, entry as WireWindow, `Current week (${name})`);
    }
  }

  windows.sort((a, b) => {
    const ai = ORDER.indexOf(a.key);
    const bi = ORDER.indexOf(b.key);
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  });

  return { windows, fetchedAt: now };
}

/**
 * Pull an OAuth token out of whatever the configured command prints.
 *
 * Claude Code stores a JSON blob, but a user may well wire this up to something
 * that prints a bare token, so both are accepted.
 */
export function extractToken(stdout: string): string | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;
  if (!text.startsWith('{')) return text.split(/\s+/)[0];
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || typeof node !== 'object') continue;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (/^(access_?token)$/i.test(key) && typeof value === 'string' && value.length > 0) {
          return value;
        }
        if (value !== null && typeof value === 'object') stack.push(value);
      }
    }
  } catch {
    // Not JSON after all — fall through.
  }
  return undefined;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Claude Code allows 5s; a panel refresh must not hang on this either. */
const FETCH_TIMEOUT_MS = 5_000;

export interface LimitsOptions {
  /**
   * Shell command printing the OAuth credential.
   *
   * Deliberately configured rather than built in: fleetwood does not ship a
   * credential scraper of its own, and the operator decides whether their token
   * is readable and how. Unset means the whole feature is off.
   */
  tokenCommand?: string;
  now?: number;
}

/**
 * Fetch the plan's quota windows.
 *
 * Returns undefined rather than throwing on every failure path — no command
 * configured, no token, a network error, an endpoint that changed shape. This is
 * decoration on a panel whose job is tmux; it must never be able to break it.
 */
export async function fetchLimits(options: LimitsOptions): Promise<PlanLimits | undefined> {
  const command = options.tokenCommand?.trim();
  if (!command) return undefined;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const printed = await run('/bin/sh', ['-c', command], { timeoutMs: FETCH_TIMEOUT_MS });
  if (printed.code !== 0) return undefined;
  const token = extractToken(printed.stdout);
  if (!token) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseLimits(await response.json(), now);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
