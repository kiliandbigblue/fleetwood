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
  /**
   * The same window in one word: `5h`, `week`, `opus`.
   *
   * The panel's status rail shows one window at a time and has about forty pixels
   * for its name, so the long title cannot go there — and truncating it produces
   * "Current we…", which names nothing. Kept beside the title it abbreviates so
   * the two cannot drift.
   */
  short: string;
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

/**
 * The quota windows we render, in reading order, with the titles `/usage` uses.
 *
 * An allowlist rather than "whatever the payload holds". The response also
 * carries `spend` (a credits object), `extra_usage`, and a set of unrelated
 * codenames — `tangelo`, `iguana_necktie`, `nimbus_quill` — and several of those
 * have a `percent` or `utilization` field of their own. Surfacing unknown keys
 * put a bogus "spend 0%" bar on screen, so a new window not showing up until
 * it's listed here is the cheaper failure.
 */
const WINDOWS: [key: string, title: string, short: string][] = [
  ['five_hour', 'Current session', '5h'],
  ['seven_day', 'Current week (all models)', 'week'],
  ['seven_day_opus', 'Current week (Opus only)', 'opus'],
  ['seven_day_sonnet', 'Current week (Sonnet only)', 'sonnet'],
  ['seven_day_cowork', 'Current week (Cowork)', 'cowork'],
  ['seven_day_oauth_apps', 'Current week (OAuth apps)', 'oauth'],
];

/**
 * Utilization as a 0..1 fraction.
 *
 * The endpoint reports whole percents — `{"five_hour": {"utilization": 77}}` is
 * 77% — so this divides by 100. Verified against a live response next to the
 * desktop app's own numbers; an earlier reading of this as a 0..1 fraction
 * pinned every bar at 100%.
 */
function fraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value / 100));
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

  const push = (key: string, wire: WireWindow, title: string, short: string): void => {
    const utilization = fraction(wire.utilization ?? wire.percent);
    if (utilization === undefined) return;
    windows.push({ key, title, short, utilization, resetsAt: epoch(wire.resets_at) });
  };

  // Most windows are null on any given plan — an account with no Opus-specific
  // cap reports `"seven_day_opus": null` rather than omitting the key.
  for (const [key, title, short] of WINDOWS) {
    const value = root[key];
    if (value === null || typeof value !== 'object') continue;
    push(key, value as WireWindow, title, short);
  }

  // Per-model weekly caps arrive in a list instead of as named keys. Only the
  // scoped ones: the same array also repeats the session and all-models windows
  // (`kind: "session"` / `"weekly_all"`, `scope: null`), which are already above.
  const scoped = root.limits;
  if (Array.isArray(scoped)) {
    for (const entry of scoped as Record<string, unknown>[]) {
      if (entry.kind !== 'weekly_scoped') continue;
      const scope = entry.scope as { model?: { display_name?: unknown } } | null | undefined;
      const name = scope?.model?.display_name;
      if (typeof name !== 'string') continue;
      // "Claude Opus 4.5" abbreviates to `opus`: the family is what distinguishes
      // one scoped cap from another, and the version never fits the rail.
      const short = (name.split(/\s+/).find((word) => !/^claude$/i.test(word)) ?? name)
        .toLowerCase();
      push(`weekly_scoped:${name}`, entry as WireWindow, `Current week (${name})`, short);
    }
  }

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
