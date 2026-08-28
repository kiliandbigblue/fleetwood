import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { run } from './exec.ts';
import { looksLikeClaude } from './claudeDaemon.ts';
import { classify, scanProcesses } from './procScan.ts';
import { nameWithOrder, sameSession, sessionLabel, sessionOrder } from './sessionOrder.ts';
import type { SessionRename } from './sessionOrder.ts';
import * as tmux from './tmux.ts';
import { resolveBaseRef, reviewBase } from './worktree.ts';
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
  const wanted = options.name ?? sessionNameFor(options.path);
  // An order prefix is a display detail, so `20-fleetwood` is still the session
  // for `fleetwood`. Matching on the raw name would create a second one.
  const sessions = await tmux.listSessions();
  const existing = sessions.find((s) => sameSession(s.name, wanted))?.name;
  const name = existing ?? wanted;

  if (!existing) {
    const created = await tmux.newSession({ name, cwd: options.path });
    if (!created) return { ok: false, detail: `could not create session ${name}` };
    if (options.meta) await tmux.setSessionMeta(name, options.meta);
  }

  if (options.background) {
    return { ok: true, detail: existing ? `session ${name} already exists` : `created ${name}` };
  }

  const focus = await focusSession(name);
  return {
    ok: focus.ok,
    detail: `${existing ? 'focused existing' : 'created and focused'} ${name}${focus.ok ? '' : ` — ${focus.detail}`}`,
  };
}

export const AGENT_COMMANDS: Record<AgentTool, string | undefined> = {
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

export interface OpenEditorOptions {
  session: string;
  cwd: string;
  /** The command to run — whatever `editor` is configured to, `nvim` by default. */
  editor: string;
  /** tmux window name. Defaults to the directory's own name. */
  name?: string;
  /** Split the current window instead of opening one of its own. */
  split?: boolean;
}

/**
 * Open an editor on a directory, in an existing session.
 *
 * Its own window rather than a split of whatever you were looking at: an editor
 * wants the full height, and "open this repo" should not halve the pane you were
 * reading. As with `spawnAgent` the command is typed into a shell instead of
 * being the pane's command, so quitting the editor leaves you at a prompt in the
 * right directory rather than closing the window.
 */
export async function openEditor(options: OpenEditorOptions): Promise<ActionResult> {
  const editor = options.editor.trim();
  if (editor.length === 0) return { ok: false, detail: 'no editor configured' };
  if (!(await tmux.hasSession(options.session))) {
    return { ok: false, detail: `no tmux session named ${options.session}` };
  }

  const paneId = options.split
    ? await tmux.splitWindow(`=${options.session}:`, { cwd: options.cwd })
    : await tmux.newWindow(options.session, {
        cwd: options.cwd,
        name: options.name ?? basename(options.cwd),
        select: true,
      });
  if (!paneId) return { ok: false, detail: 'could not create a pane' };

  if (!(await tmux.sendText(paneId, editor))) {
    return { ok: false, detail: `created ${paneId} but could not type ${editor}` };
  }

  // Landing you in the editor is the point; creating it out of sight is not.
  const focus = await focusSession(options.session);
  return {
    ok: true,
    detail: `${editor} in ${paneId} on ${basename(options.cwd)}${focus.ok ? '' : ` — ${focus.detail}`}`,
  };
}

const DIFIT = 'difit';

/** How long difit gets to say it is up before the click is reported as failed. */
const DIFIT_STARTUP_MS = 15_000;

/**
 * How long to keep listening after difit prints its address.
 *
 * "No differences found" follows the address by microseconds, and the two mean
 * opposite things — see `openDifit`. Settling is what lets one read of the output
 * tell them apart, and at this length it is imperceptible.
 */
const DIFIT_SETTLE_MS = 400;

/** The arguments a review runs with. One place decides, and the tests read it here. */
export function difitArgs(base: string): string[] {
  return ['.', base, '--merge-base', '--include-untracked'];
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

export interface DifitStartup {
  /** Where the review is, once difit has bound a port. */
  url?: string;
  /**
   * difit found nothing between the base and the worktree.
   *
   * It says so, and pointedly does *not* open a browser — which makes it the one
   * outcome that never cleans itself up, since nothing will ever connect and so
   * nothing will ever disconnect. The caller kills it instead.
   */
  empty?: boolean;
}

/**
 * What difit's opening lines say about whether there is a review to look at.
 *
 * Pure, and reading the whole output each time rather than line by line, because
 * both facts can land in the same chunk and the interesting case is the one where
 * they both do.
 */
export function readDifitStartup(output: string): DifitStartup {
  const clean = stripAnsi(output);
  const url = /https?:\/\/\S+/.exec(clean)?.[0]?.replace(/[.,)]+$/, '');
  const empty = /No differences found/i.test(clean);
  return { ...(url ? { url } : {}), ...(empty ? { empty: true } : {}) };
}

/**
 * The line worth showing when difit exits instead of starting.
 *
 * difit reports its own failures as `Error: Error: …`, so the doubled prefix is
 * dropped rather than shown to someone who did not ask how difit is written.
 */
export function readDifitFailure(output: string, code: number | null): string {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const said = lines.find((line) => /^Error\b/i.test(line)) ?? lines.at(-1);
  return said
    ? `difit: ${said.replace(/^Error:\s*(Error:\s*)?/i, '')}`
    : `difit exited ${code === null ? 'on a signal' : `with ${code}`} without saying why`;
}

export interface OpenDifitOptions {
  /** The worktree to review. Its own work, not the task folder's. */
  cwd: string;
  /**
   * What this branch is really based on, when something knows.
   *
   * In practice the head pull request's own base, taken from the snapshot the card
   * already has. It matters only for stacked work, and there it is the whole
   * answer: reviewed against the trunk, a layer is credited with every commit the
   * layers below it added. A name, not a ref — `resolveBaseRef` decides which form
   * of it this worktree can actually diff against, and the trunk is used if it can
   * use neither.
   */
  base?: string;
  /** Override the startup wait. Tests use it; nothing else needs to. */
  startupMs?: number;
}

/**
 * Start a difit review server on one worktree, and let difit open the browser.
 *
 * `difit . <base> --merge-base` is the whole argument for this being one button
 * rather than a menu: `.` is the worktree as it stands — committed branch work and
 * uncommitted edits together — and `--merge-base` pins the other side to where the
 * branch left its base, so commits landed there since then don't show up as this
 * branch's doing. It is the diff a pull request would show, plus whatever isn't
 * committed yet, which is what an agent's work looks like when you go to read it.
 *
 * `--merge-base` is also what makes a stacked layer work without knowing anything
 * about the shape of the stack. A layer is typically cut from its parent's *first*
 * commit and the parent then moves on, so the two are not ancestors of each other
 * in either direction — but the fork point is still their merge base, and it does
 * not move when the parent advances. Naming the parent is enough; see `base`.
 *
 * `--include-untracked` is not optional in practice. Without it difit stops to ask
 * `(Y/n)` whenever the worktree holds a new file — and there is no terminal here to
 * ask in, so it would hang rather than prompt. It marks them `--intent-to-add`, so
 * `git status` shows them as added until `git reset --` puts them back.
 *
 * **No terminal is involved.** difit is spawned straight from here: it needs no tty
 * once untracked files are settled by flag, it opens the browser itself, and the
 * browser is where the review is read — a tmux window would only have been a place
 * for the process to sit. What that window did give was a way to stop the server
 * and somewhere to see it fail, and neither is lost: difit holds an SSE stream for
 * the tab and exits when it closes, and a failure to start is read off its output
 * and returned as this call's `detail` rather than buried in a pane nobody opened.
 *
 * Detached and unref'd on purpose, so a review outlives the panel that opened it.
 * The `--background` flag is still deliberately unused: it forces difit's own
 * `--keep-alive`, which is exactly the self-shutdown this depends on.
 */
export async function openDifit(options: OpenDifitOptions): Promise<ActionResult> {
  // The pull request's base first, the trunk only when there is none to use. A
  // stacked layer is the case that needs it, and a base that does not resolve here
  // is treated as absent rather than passed on for difit to reject.
  const base =
    (options.base ? await resolveBaseRef(options.cwd, options.base) : undefined) ??
    (await reviewBase(options.cwd));
  if (!base) {
    return {
      ok: false,
      detail: `no trunk found in ${basename(options.cwd)} — nothing to review against`,
    };
  }

  const where = basename(options.cwd);
  const args = difitArgs(base);

  return await new Promise<ActionResult>((resolve) => {
    const child = spawn(DIFIT, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let output = '';
    let settle: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (result: ActionResult, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(settle);
      clearTimeout(deadline);
      if (kill) {
        child.kill();
      } else {
        // Drained rather than closed: difit still writes on its way out, and a
        // destroyed pipe would hand it EPIPE instead of letting it finish.
        child.stdout?.resume();
        child.stderr?.resume();
        child.unref();
      }
      resolve(result);
    };

    const nothingToReview = (): void =>
      finish({ ok: false, detail: `nothing to review in ${where} against ${base}` }, true);

    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      const startup = readDifitStartup(output);
      if (startup.empty) return nothingToReview();
      if (!startup.url || settle) return;
      settle = setTimeout(() => {
        if (readDifitStartup(output).empty) return nothingToReview();
        finish({ ok: true, detail: `difit on ${where} vs ${base} — ${startup.url}` }, false);
      }, DIFIT_SETTLE_MS);
    };

    child.stdout.on('data', read);
    child.stderr.on('data', read);

    child.on('error', (error) => {
      const enoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
      finish(
        {
          ok: false,
          detail: enoent
            ? 'difit is not on PATH — install it with `npm i -g difit`'
            : `could not start difit: ${error.message}`,
        },
        false,
      );
    });

    // Exited before it was ready, so whatever it printed is the reason.
    child.on('exit', (code) => finish({ ok: false, detail: readDifitFailure(output, code) }, false));

    const deadline = setTimeout(
      () => finish({ ok: false, detail: `difit did not start in ${where} — gave up waiting` }, true),
      options.startupMs ?? DIFIT_STARTUP_MS,
    );
  });
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
  // Attached clients are moved to the oldest surviving session first, so closing a
  // card from the panel cannot dump the terminal out of tmux.
  const { killed, switchedTo } = await tmux.killSessionKeepingClients(name);
  if (!killed) return { ok: false, detail: `could not kill ${name}` };
  return { ok: true, detail: `killed ${name}${switchedTo ? ` — focused ${switchedTo}` : ''}` };
}

export async function renameSession(from: string, to: string): Promise<ActionResult> {
  const ok = await tmux.renameSession(from, to);
  return ok
    ? { ok: true, detail: `renamed ${from} → ${to}` }
    : { ok: false, detail: `could not rename ${from}` };
}

/**
 * Put a session in a slot, or take it out of the ordering entirely.
 *
 * `undefined` strips the prefix, which is how a session goes back to being sorted
 * by what it is doing rather than by where you put it.
 */
export async function setSessionOrder(
  session: string,
  order: number | undefined,
): Promise<ActionResult> {
  if (!(await tmux.hasSession(session))) {
    return { ok: false, detail: `no tmux session named ${session}` };
  }
  const target = nameWithOrder(session, order);
  if (target === session) {
    return order === undefined
      ? { ok: true, detail: `${session} was already unordered` }
      : { ok: true, detail: `${sessionLabel(session)} was already in slot ${order}` };
  }
  if (!(await tmux.renameSession(session, target))) {
    // The one way this fails on its own: two sessions sharing a label, where the
    // slot being asked for is the other one's name. tmux refuses a duplicate.
    return { ok: false, detail: `tmux refused to rename ${session} → ${target}` };
  }
  return order === undefined
    ? { ok: true, detail: `${sessionLabel(session)} is no longer ordered` }
    : { ok: true, detail: `${sessionLabel(session)} moved to slot ${order}` };
}

/**
 * Apply a reorder plan, stopping at the first rename tmux refuses.
 *
 * Stopping rather than pressing on: the plan is a set of slots that only makes
 * sense whole, and finishing it around a hole would leave two sessions sharing a
 * number. Half-applied is recoverable — the next move replans from what is
 * actually there — while wrong-but-complete is not.
 */
export async function applyReorder(
  renames: SessionRename[],
  /** The session the move was about, so the toast names it and not a bystander. */
  moved: string,
): Promise<ActionResult> {
  if (renames.length === 0) return { ok: true, detail: `${sessionLabel(moved)} is already there` };

  let applied = 0;
  for (const rename of renames) {
    if (!(await tmux.renameSession(rename.from, rename.to))) {
      const detail = `tmux refused to rename ${rename.from} → ${rename.to}`;
      return {
        ok: false,
        detail: applied > 0 ? `${detail} — ${applied} of ${renames.length} applied` : detail,
      };
    }
    applied += 1;
  }

  const name = renames.find((r) => r.from === moved)?.to ?? moved;
  const others = renames.length - 1;
  return {
    ok: true,
    detail: `${sessionLabel(name)} → slot ${sessionOrder(name) ?? '—'}${
      others > 0 ? ` (${others} other session${others === 1 ? '' : 's'} renumbered)` : ''
    }`,
  };
}
