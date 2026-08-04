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
    .filter((l) => l.length > 0)
    .map((line) => {
      const f = splitRow(line, SESSION_FIELDS.length);
      const kind = optional(f[5]);
      return {
        sessionId: f[0] ?? '',
        name: f[1] ?? '',
        attached: num(f[2]),
        createdAt: num(f[3]),
        path: f[4] ?? '',
        meta: {
          kind: kind as SessionMeta['kind'],
          repo: optional(f[6]),
          branch: optional(f[7]),
          pr: optional(f[8]),
          worktree: optional(f[9]),
        },
      } satisfies SessionRow;
    });
}

export function parsePanes(stdout: string): PaneRow[] {
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const f = splitRow(line, PANE_FIELDS.length);
      return {
        sessionId: f[0] ?? '',
        sessionName: f[1] ?? '',
        windowId: f[2] ?? '',
        windowIndex: num(f[3]),
        windowName: f[4] ?? '',
        windowActive: flag(f[5]),
        paneId: f[6] ?? '',
        paneIndex: num(f[7]),
        pid: num(f[8]),
        command: f[9] ?? '',
        cwd: f[10] ?? '',
        active: flag(f[11]),
        width: num(f[12]),
        height: num(f[13]),
        title: f[14] ?? '',
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

// --- tmux invocations ------------------------------------------------------

async function tmux(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await run('tmux', args);
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
  const { stdout } = await run('tmux', ['-V']);
  return stdout.trim().replace(/^tmux\s+/, '');
}
