import { run } from './exec.ts';
import type { PaneInfo, SessionInfo, SessionMeta, WindowInfo } from './types.ts';

/**
 * Unit separator. Pane titles routinely contain spaces, pipes and unicode
 * (Claude Code writes its current activity into the title), so we need a
 * delimiter no sane program emits.
 */
const SEP = '\x1f';

const SESSION_FIELDS = [
  'session_id',
  'session_name',
  'session_attached',
  'session_created',
  'session_path',
  '@fw_kind',
  '@fw_repo',
  '@fw_branch',
  '@fw_pr',
  '@fw_worktree',
  '@fw_task',
  '@fw_taskdir',
] as const;

const PANE_FIELDS = [
  'session_id',
  'session_name',
  'window_id',
  'window_index',
  'window_name',
  'window_active',
  'pane_id',
  'pane_index',
  'pane_pid',
  'pane_current_command',
  'pane_current_path',
  'pane_active',
  'pane_width',
  'pane_height',
  // Last: titles are the field most likely to contain surprises, and putting it
  // last means a stray separator inside it cannot shift any other column.
  'pane_title',
] as const;

function formatOf(fields: readonly string[]): string {
  return fields.map((f) => `#{${f}}`).join(SEP);
}

/** Split a format line, tolerating extra separators inside the final field. */
function splitRow(line: string, count: number): string[] {
  const parts = line.split(SEP);
  if (parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(SEP)];
}

/**
 * Read a row into a field-keyed map.
 *
 * Keyed rather than positional so adding a field to the format cannot silently
 * shift every value after it.
 */
function rowToMap(fields: readonly string[], line: string): Record<string, string> {
  const parts = splitRow(line, fields.length);
  const out: Record<string, string> = {};
  fields.forEach((field, index) => {
    out[field] = parts[index] ?? '';
  });
  return out;
}

/**
 * A row is only data if it still has its separators.
 *
 * Every format here has more than one field, so a non-empty line with no \x1f in
 * it was mangled in transit (see `tmuxEnv`). Parsing it anyway invents a session
 * whose every field is empty — no name, no path, no panes — which the panel
 * renders as a real card, so an empty fleet is the more honest reading.
 */
function intact(line: string): boolean {
  return line.length > 0 && line.includes(SEP);
}

function num(v: string | undefined, fallback = 0): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** tmux emits "1"/"0" for flag formats. */
function flag(v: string | undefined): boolean {
  return v === '1';
}

/** An empty user option is indistinguishable from an unset one in a format. */
function optional(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

export interface SessionRow {
  sessionId: string;
  name: string;
  attached: number;
  createdAt: number;
  path: string;
  meta: SessionMeta;
}

export interface PaneRow extends PaneInfo {
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
}

// --- Pure parsers (unit-tested against real tmux output fixtures) -----------

export function parseSessions(stdout: string): SessionRow[] {
  return stdout
    .split('\n')
    .filter(intact)
    .map((line) => {
      const f = rowToMap(SESSION_FIELDS, line);
      return {
        sessionId: f['session_id'] ?? '',
        name: f['session_name'] ?? '',
        attached: num(f['session_attached']),
        createdAt: num(f['session_created']),
        path: f['session_path'] ?? '',
        meta: {
          kind: optional(f['@fw_kind']) as SessionMeta['kind'],
          repo: optional(f['@fw_repo']),
          branch: optional(f['@fw_branch']),
          pr: optional(f['@fw_pr']),
          worktree: optional(f['@fw_worktree']),
          task: optional(f['@fw_task']),
          taskdir: optional(f['@fw_taskdir']),
        },
      } satisfies SessionRow;
    });
}

export function parsePanes(stdout: string): PaneRow[] {
  return stdout
    .split('\n')
    .filter(intact)
    .map((line) => {
      const f = rowToMap(PANE_FIELDS, line);
      return {
        sessionId: f['session_id'] ?? '',
        sessionName: f['session_name'] ?? '',
        windowId: f['window_id'] ?? '',
        windowIndex: num(f['window_index']),
        windowName: f['window_name'] ?? '',
        windowActive: flag(f['window_active']),
        paneId: f['pane_id'] ?? '',
        paneIndex: num(f['pane_index']),
        pid: num(f['pane_pid']),
        command: f['pane_current_command'] ?? '',
        cwd: f['pane_current_path'] ?? '',
        active: flag(f['pane_active']),
        width: num(f['pane_width']),
        height: num(f['pane_height']),
        title: f['pane_title'] ?? '',
      } satisfies PaneRow;
    });
}

/** Stitch flat pane rows into the session → window → pane tree. */
export function buildTree(sessions: SessionRow[], panes: PaneRow[]): SessionInfo[] {
  const bySession = new Map<string, PaneRow[]>();
  for (const p of panes) {
    const list = bySession.get(p.sessionId);
    if (list) list.push(p);
    else bySession.set(p.sessionId, [p]);
  }

  return sessions.map((s) => {
    const rows = bySession.get(s.sessionId) ?? [];
    const windows = new Map<string, WindowInfo>();
    for (const r of rows) {
      let w = windows.get(r.windowId);
      if (!w) {
        w = {
          windowId: r.windowId,
          index: r.windowIndex,
          name: r.windowName,
          active: r.windowActive,
          panes: [],
        };
        windows.set(r.windowId, w);
      }
      const { windowIndex: _wi, windowName: _wn, windowActive: _wa, ...pane } = r;
      w.panes.push(pane);
    }
    for (const w of windows.values()) w.panes.sort((a, b) => a.paneIndex - b.paneIndex);
    return {
      sessionId: s.sessionId,
      name: s.name,
      attached: s.attached,
      createdAt: s.createdAt,
      path: s.path,
      meta: s.meta,
      windows: [...windows.values()].sort((a, b) => a.index - b.index),
    } satisfies SessionInfo;
  });
}

export interface TaskSessionMatch {
  session: SessionRow;
  /** True when the match came from name/path, not the `@fw_task` option. */
  adopted: boolean;
}

/**
 * The session working a task: by `@fw_task` first, then by name or path.
 *
 * A restore tool (tmux-resurrect) rebuilds a session's name, cwd and panes but
 * has no idea about our tmux user options, so a session it recreates comes
 * back with no `@fw_task` at all — matching on the option alone would make
 * every task look dormant again after a restore. Falling back to the name
 * `ensureTaskSession` would have given it (the slug) or its path (the task
 * folder) reclaims it; the caller re-stamps the options once it does.
 */
export function findTaskSession(
  sessions: SessionRow[],
  slug: string,
  dir: string,
): TaskSessionMatch | undefined {
  const stamped = sessions.find((s) => s.meta.task === slug);
  if (stamped) return { session: stamped, adopted: false };
  const orphan = sessions.find((s) => !s.meta.task && (s.name === slug || s.path === dir));
  return orphan ? { session: orphan, adopted: true } : undefined;
}

// --- tmux invocations ------------------------------------------------------

/**
 * tmux inherits our environment, plus a UTF-8 locale.
 *
 * tmux considers a client UTF-8 capable only when LC_ALL, LC_CTYPE or LANG names
 * a UTF-8 locale. Every other client gets its command output through
 * `utf8_sanitize()`, which rewrites each non-printable byte as "_" — including
 * the \x1f separator every format above is built from. Launched from Finder or
 * the Dock, a macOS app inherits none of those three from launchd, so the
 * packaged app read each session as one unsplit field: a card with no name, no
 * path and no panes, and every hook-reported agent filed under "pane gone"
 * because the pane it named appeared nowhere in the tree.
 *
 * LC_ALL, because it is the variable tmux consults first and so the only one
 * nothing else can override. Read per call rather than once, since the app
 * repairs PATH after this module loads. Scoped to tmux: git, gh and ps keep the
 * user's own locale.
 */
export function tmuxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'en_US.UTF-8' };
}

async function tmux(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await run('tmux', args, { env: tmuxEnv() });
  return { ok: code === 0, stdout, stderr };
}

/** False when no tmux server is running — the normal empty state, not an error. */
export async function serverRunning(): Promise<boolean> {
  const { ok } = await tmux(['has-session']);
  // `has-session` with no target errors on a live server too, so check the
  // message: a dead server says "no server running on ...".
  if (ok) return true;
  const { stderr } = await tmux(['list-sessions', '-F', '#{session_id}']);
  return !stderr.includes('no server running');
}

export async function listSessions(): Promise<SessionRow[]> {
  const { ok, stdout } = await tmux(['list-sessions', '-F', formatOf(SESSION_FIELDS)]);
  return ok ? parseSessions(stdout) : [];
}

export async function listPanes(): Promise<PaneRow[]> {
  const { ok, stdout } = await tmux(['list-panes', '-a', '-F', formatOf(PANE_FIELDS)]);
  return ok ? parsePanes(stdout) : [];
}

/** One full snapshot of tmux state. Two cheap invocations. */
export async function snapshot(): Promise<SessionInfo[]> {
  const [sessions, panes] = await Promise.all([listSessions(), listPanes()]);
  return buildTree(sessions, panes);
}

export async function capturePane(paneId: string, lines = 30): Promise<string> {
  const { ok, stdout } = await tmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
  return ok ? stdout : '';
}

export async function hasSession(name: string): Promise<boolean> {
  const { ok } = await tmux(['has-session', '-t', `=${name}`]);
  return ok;
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** Leave detached (the default) so the caller decides when to focus. */
  attach?: boolean;
  windowName?: string;
}

export async function newSession(opts: NewSessionOptions): Promise<boolean> {
  const args = ['new-session', opts.attach ? '-s' : '-ds', opts.name, '-c', opts.cwd];
  if (opts.windowName) args.push('-n', opts.windowName);
  const { ok } = await tmux(args);
  return ok;
}

export async function killSession(name: string): Promise<boolean> {
  const { ok } = await tmux(['kill-session', '-t', `=${name}`]);
  return ok;
}

export async function renameSession(from: string, to: string): Promise<boolean> {
  const { ok } = await tmux(['rename-session', '-t', `=${from}`, to]);
  return ok;
}

export async function newWindow(
  session: string,
  opts: { cwd: string; name?: string; select?: boolean },
): Promise<string | undefined> {
  const args = ['new-window', '-t', `=${session}:`, '-c', opts.cwd, '-P', '-F', '#{pane_id}'];
  if (!opts.select) args.push('-d');
  if (opts.name) args.push('-n', opts.name);
  const { ok, stdout } = await tmux(args);
  return ok ? stdout.trim() : undefined;
}

export async function splitWindow(
  target: string,
  opts: { cwd: string; horizontal?: boolean },
): Promise<string | undefined> {
  const args = [
    'split-window',
    opts.horizontal ? '-h' : '-v',
    '-t',
    target,
    '-c',
    opts.cwd,
    '-P',
    '-F',
    '#{pane_id}',
  ];
  const { ok, stdout } = await tmux(args);
  return ok ? stdout.trim() : undefined;
}

/**
 * Send literal text, then Enter as a separate call.
 *
 * `-l` stops tmux interpreting the payload as key names, which matters because
 * agent prompts contain things like "C-c" and "Enter" as ordinary words.
 */
export async function sendText(paneId: string, text: string, submit = true): Promise<boolean> {
  const typed = await tmux(['send-keys', '-t', paneId, '-l', text]);
  if (!typed.ok) return false;
  if (!submit) return true;
  const { ok } = await tmux(['send-keys', '-t', paneId, 'Enter']);
  return ok;
}

/** Send named keys ("Enter", "Escape", "1", "C-c"). */
export async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  const { ok } = await tmux(['send-keys', '-t', paneId, ...keys]);
  return ok;
}

const META_OPTIONS: Record<keyof SessionMeta, string> = {
  kind: '@fw_kind',
  repo: '@fw_repo',
  branch: '@fw_branch',
  pr: '@fw_pr',
  worktree: '@fw_worktree',
  task: '@fw_task',
  taskdir: '@fw_taskdir',
};

/**
 * Stamp fleetwood metadata onto the session itself, so tmux stays the truth.
 *
 * Note the bare session name: unlike has-session, kill-session, rename-session
 * and new-window, `set-option -t` does not accept the `=` exact-match prefix and
 * fails with "no such session: =name". Verified against tmux 3.6a.
 */
export async function setSessionMeta(session: string, meta: SessionMeta): Promise<void> {
  for (const [key, option] of Object.entries(META_OPTIONS) as [keyof SessionMeta, string][]) {
    const value = meta[key];
    if (value === undefined) continue;
    await tmux(['set-option', '-t', session, option, value]);
  }
}

export async function clearSessionMeta(session: string): Promise<void> {
  for (const option of Object.values(META_OPTIONS)) {
    await tmux(['set-option', '-u', '-t', session, option]);
  }
}

export interface ClientInfo {
  tty: string;
  session: string;
  termName: string;
}

export async function listClients(): Promise<ClientInfo[]> {
  const { ok, stdout } = await tmux([
    'list-clients',
    '-F',
    ['#{client_tty}', '#{client_session}', '#{client_termname}'].join(SEP),
  ]);
  if (!ok) return [];
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(SEP);
      return { tty: f[0] ?? '', session: f[1] ?? '', termName: f[2] ?? '' };
    });
}

/** Point every attached client at `session`. No-op when nothing is attached. */
export async function switchClient(session: string): Promise<boolean> {
  const clients = await listClients();
  if (clients.length === 0) return false;
  let any = false;
  for (const c of clients) {
    const { ok } = await tmux(['switch-client', '-c', c.tty, '-t', `=${session}`]);
    any = any || ok;
  }
  return any;
}

export interface KillPlan {
  /** The session to move clients to, or undefined when there is nowhere to go. */
  switchTo?: string;
  /** Only the ttys attached to the doomed session; clients elsewhere are left alone. */
  ttys: string[];
}

/**
 * Where the clients watching a session should go before it is killed.
 *
 * Killing the session a client is attached to detaches that client, and a Ghostty
 * window whose `tmux attach` just exited falls back to the shell that launched
 * it — the window resumes, and fleetwood is left driving a terminal that is no
 * longer inside tmux. Moving those clients to the oldest surviving session first
 * keeps them in tmux; the kill then detaches nobody.
 *
 * "Oldest" and not "the one after this": the first session is the one the user
 * started their day in, so it is the least surprising place to land.
 */
export function planSessionKill(
  sessions: SessionRow[],
  clients: ClientInfo[],
  name: string,
): KillPlan {
  const ttys = clients.filter((c) => c.session === name).map((c) => c.tty);
  if (ttys.length === 0) return { ttys: [] };
  const survivors = sessions
    .filter((s) => s.name !== name)
    // createdAt has one-second resolution, so ties are real; name keeps them stable.
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return { switchTo: survivors[0]?.name, ttys };
}

export interface KillOutcome {
  killed: boolean;
  /** The session the clients were moved to, when there was one to move them to. */
  switchedTo?: string;
}

/**
 * Kill a session, first moving anything attached to it out of the way.
 *
 * With no other session left there is nowhere to move to, so the client detaches
 * exactly as it used to.
 */
export async function killSessionKeepingClients(name: string): Promise<KillOutcome> {
  const [sessions, clients] = await Promise.all([listSessions(), listClients()]);
  const plan = planSessionKill(sessions, clients, name);

  let switchedTo: string | undefined;
  if (plan.switchTo) {
    for (const tty of plan.ttys) {
      const { ok } = await tmux(['switch-client', '-c', tty, '-t', `=${plan.switchTo}`]);
      if (ok) switchedTo = plan.switchTo;
    }
  }

  return { killed: await killSession(name), switchedTo };
}

/** The active pane of a session, for running something in the window it already has. */
export async function activePane(session: string): Promise<string | undefined> {
  const { ok, stdout } = await tmux(['display-message', '-p', '-t', `=${session}`, '#{pane_id}']);
  const id = stdout.trim();
  return ok && id.length > 0 ? id : undefined;
}

/** Which session a pane belongs to, for turning a pane id into something focusable. */
export async function sessionOfPane(paneId: string): Promise<string | undefined> {
  const { ok, stdout } = await tmux(['display-message', '-p', '-t', paneId, '#{session_name}']);
  const name = stdout.trim();
  return ok && name.length > 0 ? name : undefined;
}

/** Make a pane active: its window within the session, and it within the window. */
export async function selectPane(paneId: string): Promise<boolean> {
  const window = await tmux(['select-window', '-t', paneId]);
  const pane = await tmux(['select-pane', '-t', paneId]);
  return window.ok && pane.ok;
}

export async function version(): Promise<string> {
  const { stdout } = await tmux(['-V']);
  return stdout.trim().replace(/^tmux\s+/, '');
}
