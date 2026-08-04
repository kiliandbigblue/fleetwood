import { basename } from 'node:path';
import { run } from './exec.ts';
import * as tmux from './tmux.ts';
import type { AgentTool, SessionMeta } from './types.ts';

export interface ActionResult {
  ok: boolean;
  /** What actually happened, for the UI to show and for `fw` to print. */
  detail: string;
}

/**
 * tmux forbids `.` and `:` in session names, and the existing tmux-sessionizer
 * derives names as `basename | tr . _`. Matching that exactly matters: it's what
 * makes `prefix+g` and fleetwood agree that a project has one session, not two.
 */
export function sessionNameFor(path: string): string {
  return basename(path).replaceAll('.', '_').replaceAll(':', '_');
}

/** Bring the terminal forward. Focusing a session is useless if it stays behind. */
async function raiseTerminal(): Promise<boolean> {
  const { code } = await run('open', ['-a', 'Ghostty']);
  return code === 0;
}

/**
 * Point the terminal at a session.
 *
 * With a client attached, every client is switched, then Ghostty is raised. With
 * nothing attached there is no client to switch, so a new Ghostty window is
 * opened already attached — on macOS the app must be launched through `open`,
 * since Ghostty refuses to start the emulator directly from a CLI invocation.
 */
export async function focusSession(name: string): Promise<ActionResult> {
  if (!(await tmux.hasSession(name))) {
    return { ok: false, detail: `no tmux session named ${name}` };
  }

  if (await tmux.switchClient(name)) {
    await raiseTerminal();
    return { ok: true, detail: `switched attached client(s) to ${name}` };
  }

  const { code, stderr } = await run('open', [
    '-na',
    'Ghostty.app',
    '--args',
    '-e',
    'tmux',
    'attach',
    '-t',
    name,
  ]);
  return code === 0
    ? { ok: true, detail: `opened a new Ghostty window attached to ${name}` }
    : { ok: false, detail: `could not launch Ghostty: ${stderr.trim() || code}` };
}

/**
 * Focus a specific pane, not just its session.
 *
 * Landing you in the right session but the wrong pane would mean hunting for the
 * agent that was asking for something — the exact friction this removes.
 */
export async function focusPane(paneId: string): Promise<ActionResult> {
  const session = await tmux.sessionOfPane(paneId);
  if (!session) return { ok: false, detail: `pane ${paneId} no longer exists` };
  await tmux.selectPane(paneId);
  const focus = await focusSession(session);
  return { ok: focus.ok, detail: focus.ok ? `focused ${paneId} in ${session}` : focus.detail };
}

export interface OpenProjectOptions {
  path: string;
  name?: string;
  meta?: SessionMeta;
  /** Create only; don't steal focus. */
  background?: boolean;
}

/**
 * Find-or-create a session for a directory, then focus it.
 *
 * Find-or-create rather than create is the whole point: clicking a project twice
 * must land you in the same place, not spawn a second session.
 */
export async function openProject(options: OpenProjectOptions): Promise<ActionResult> {
  const name = options.name ?? sessionNameFor(options.path);
  const existed = await tmux.hasSession(name);

  if (!existed) {
    const created = await tmux.newSession({ name, cwd: options.path });
    if (!created) return { ok: false, detail: `could not create session ${name}` };
    if (options.meta) await tmux.setSessionMeta(name, options.meta);
  }

  if (options.background) {
    return { ok: true, detail: existed ? `session ${name} already exists` : `created ${name}` };
  }

  const focus = await focusSession(name);
  return {
    ok: focus.ok,
    detail: `${existed ? 'focused existing' : 'created and focused'} ${name}${focus.ok ? '' : ` — ${focus.detail}`}`,
  };
}

const AGENT_COMMANDS: Record<AgentTool, string | undefined> = {
  claude: 'claude',
  cursor: 'cursor-agent',
  codex: 'codex',
  unknown: undefined,
};

export interface SpawnAgentOptions {
  session: string;
  tool: AgentTool;
  cwd: string;
  /** Text typed after the agent starts. Not sent until the agent is ready. */
  prompt?: string;
  /** New window (default) or a split of the current one. */
  split?: boolean;
  windowName?: string;
  /**
   * Start in the window the session already has rather than making another.
   *
   * A freshly created session comes with one window already sitting in the right
   * directory; without this the agent would land in a second, redundant one.
   */
  reuseWindow?: boolean;
}

/**
 * Start an agent in its own pane.
 *
 * The command is typed into a shell rather than exec'd as the pane command, so
 * the pane survives the agent exiting and you keep the scrollback.
 */
export async function spawnAgent(options: SpawnAgentOptions): Promise<ActionResult> {
  const command = AGENT_COMMANDS[options.tool];
  if (!command) return { ok: false, detail: `no launch command known for ${options.tool}` };

  const paneId = options.reuseWindow
    ? await tmux.activePane(options.session)
    : options.split
      ? await tmux.splitWindow(`=${options.session}:`, { cwd: options.cwd })
      : await tmux.newWindow(options.session, {
          cwd: options.cwd,
          name: options.windowName ?? options.tool,
          select: true,
        });

  if (!paneId) return { ok: false, detail: 'could not create a pane' };

  const sent = await tmux.sendText(paneId, command);
  if (!sent) return { ok: false, detail: `created ${paneId} but could not type the command` };

  return {
    ok: true,
    detail: options.prompt
      ? `started ${command} in ${paneId}; prompt not sent automatically (agent may still be booting)`
      : `started ${command} in ${paneId}`,
  };
}

/** Type a prompt into an agent's pane and submit it. */
export async function sendPrompt(paneId: string, text: string): Promise<ActionResult> {
  const ok = await tmux.sendText(paneId, text);
  return ok
    ? { ok: true, detail: `sent ${text.length} chars to ${paneId}` }
    : { ok: false, detail: `could not send to ${paneId}` };
}

/**
 * Answer a permission prompt.
 *
 * Claude Code's numbered options are single-keystroke: the digit both selects and
 * confirms, so sending Enter as well would answer whatever prompt came next.
 */
export async function answerPrompt(paneId: string, key: string): Promise<ActionResult> {
  if (!/^[0-9]$/.test(key)) return { ok: false, detail: `refusing to send "${key}" as an answer` };
  const ok = await tmux.sendKeys(paneId, [key]);
  return ok
    ? { ok: true, detail: `answered ${key} in ${paneId}` }
    : { ok: false, detail: `could not answer in ${paneId}` };
}

/** Interrupt a working agent (Escape, as Ctrl-C would kill the process). */
export async function interruptAgent(paneId: string): Promise<ActionResult> {
  const ok = await tmux.sendKeys(paneId, ['Escape']);
  return ok
    ? { ok: true, detail: `sent Escape to ${paneId}` }
    : { ok: false, detail: `could not interrupt ${paneId}` };
}

export async function killSession(name: string): Promise<ActionResult> {
  const ok = await tmux.killSession(name);
  return ok ? { ok: true, detail: `killed ${name}` } : { ok: false, detail: `could not kill ${name}` };
}

export async function renameSession(from: string, to: string): Promise<ActionResult> {
  const ok = await tmux.renameSession(from, to);
  return ok
    ? { ok: true, detail: `renamed ${from} → ${to}` }
    : { ok: false, detail: `could not rename ${from}` };
}
