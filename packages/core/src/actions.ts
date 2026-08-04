import { basename } from 'node:path';
import { run } from './exec.ts';
import { looksLikeClaude } from './claudeDaemon.ts';
import { classify, scanProcesses } from './procScan.ts';
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

/**
 * What we know about an agent we've been asked to close.
 *
 * A structural subset of `FleetAgent`, so a caller passes the agent it already
 * has — declared here rather than imported so this module stays independent of
 * the fleet builder.
 */
export interface AgentTarget {
  tool: AgentTool;
  /** What process reconciliation matched: the daemon worker, or the pane's outermost agent. */
  pid?: number;
  /** The pid the agent's own hooks reported (`$CLAUDE_PID`). */
  hookPid?: number;
  nested?: boolean;
  hosted?: 'daemon';
  pane?: string;
}

export interface KillPlan {
  /** Pids worth signalling, most trustworthy first. */
  candidates: number[];
  /** Set when nothing here is safe to signal, in the words the UI should show. */
  refusal?: string;
}

/**
 * Which pid actually *is* a given agent.
 *
 * This is the whole risk in closing one agent out of several: every case has a
 * plausible-looking pid that belongs to a different agent, and killing it would
 * take down the wrong session.
 *
 * - A **daemon-hosted** agent runs in the roster's worker. Its `$CLAUDE_PID` is
 *   the pooled `bg-spare` helper — spawned early, outliving the session — so the
 *   hook's pid is refused outright here, never used as a fallback.
 * - A **nested** agent shares its pane with the agent that spawned it, and the
 *   pane's outermost process is that parent. Only the pid it reported itself will
 *   do; with none, there is nothing safe to signal.
 * - Otherwise the agent's own report is preferred — it is the one thing that
 *   distinguishes two agents sharing a pane — with the pane match behind it for
 *   agents that never sent a hook at all.
 *
 * Pure so the precedence can be tested without processes to kill; the caller
 * still has to confirm a candidate is that agent before signalling it.
 */
export function planKillAgent(agent: AgentTarget): KillPlan {
  const real = (pid: number | undefined): pid is number => pid !== undefined && pid > 1;

  if (agent.hosted === 'daemon') {
    return real(agent.pid)
      ? { candidates: [agent.pid] }
      : { candidates: [], refusal: `no worker process known for this ${agent.tool} session` };
  }

  if (agent.nested) {
    return real(agent.hookPid)
      ? { candidates: [agent.hookPid] }
      : {
          candidates: [],
          refusal: `this ${agent.tool} never reported its own pid — closing it would risk killing the agent that spawned it`,
        };
  }

  const candidates = [agent.hookPid, agent.pid].filter(real);
  return candidates.length > 0
    ? { candidates: [...new Set(candidates)] }
    : { candidates: [], refusal: `no process known for this ${agent.tool}` };
}

/** Is `pid` still running? EPERM means yes — running, just not ours to poke. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Is the process at a candidate pid still the agent we recorded, and not a recycled pid? */
function stillTheAgent(command: string, agent: AgentTarget): boolean {
  // A daemon worker runs as `claude bg-pty-host …`, which the agent matchers
  // deliberately exclude — it must not read as a second agent in a pane — so it
  // gets the looser check the roster reconciliation uses.
  if (agent.hosted === 'daemon') return looksLikeClaude(command);
  return classify(command) === agent.tool;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface KillAgentOptions {
  /** How long SIGTERM gets to work before SIGKILL. */
  graceMs?: number;
}

/**
 * Close one agent, leaving its pane, its session and its neighbours alone.
 *
 * Killing the *process* rather than the pane is what makes this usable on a
 * session running several agents: the pane keeps its shell and its scrollback,
 * so the transcript of what the agent did is still there to read. It is also the
 * only thing that works for the two cases where pane and agent aren't the same
 * thing — a daemon-hosted agent, whose pane holds a thin client, and a nested
 * one, which shares its parent's pane.
 *
 * SIGTERM first so the agent can flush its transcript and remove its own roster
 * entry, then SIGKILL if it ignores that. A UI action that reports success while
 * the agent keeps running would be worse than one that admits to forcing it.
 */
export async function killAgent(
  agent: AgentTarget,
  options: KillAgentOptions = {},
): Promise<ActionResult> {
  const plan = planKillAgent(agent);
  if (plan.refusal) return { ok: false, detail: plan.refusal };

  const table = await scanProcesses();
  const candidates = plan.candidates.filter((pid) => pid !== process.pid);
  const target = candidates.find((pid) => {
    const row = table.byPid.get(pid);
    return row ? stillTheAgent(row.command, agent) : false;
  });

  const what =
    agent.hosted === 'daemon'
      ? `${agent.tool}'s daemon worker`
      : agent.nested
        ? `nested ${agent.tool}`
        : agent.tool;

  if (target === undefined) {
    // Either it exited on its own between the snapshot and this click, or the pid
    // has been reused by something unrelated. Both mean: don't send a signal.
    const running = candidates.some((pid) => table.byPid.has(pid));
    return {
      ok: false,
      detail: running
        ? `pid ${candidates.join('/')} is no longer ${agent.tool} — refusing to kill it`
        : `${what} is already gone`,
    };
  }

  if (!signal(target, 'SIGTERM')) {
    return { ok: false, detail: `could not signal pid ${target} — it may not be yours to kill` };
  }

  const graceMs = options.graceMs ?? 2_000;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!pidAlive(target)) {
      return { ok: true, detail: `closed ${what} (pid ${target})${agent.pane ? ` in ${agent.pane}` : ''}` };
    }
  }

  signal(target, 'SIGKILL');
  await sleep(150);
  return pidAlive(target)
    ? { ok: false, detail: `${what} (pid ${target}) survived SIGTERM and SIGKILL` }
    : {
        ok: true,
        detail: `closed ${what} (pid ${target}) — SIGKILL, it ignored SIGTERM for ${Math.round(graceMs / 1000)}s`,
      };
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
