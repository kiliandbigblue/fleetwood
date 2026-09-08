import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { actions, repoIndex, task as taskApi } from '@fleetwood/core';
import type { AgentTool } from '@fleetwood/core';
import { TASK_TYPES, buildBranch, slugify } from '@fleetwood/core/naming';
import { c, currentPalette, tildify } from './ui.ts';

/*
 * `fw new` — what `prefix+N` runs.
 *
 * The sibling of `fw switch`, and built the same way: one node process that
 * drives a picker over pipes, acts on the answers itself, and lives inside a
 * `display-popup` that closes the moment it returns. There the picker is fzf,
 * because the binding it replaced was already fzf. Here it is gum, because the
 * questions are a form rather than a list — four of them, each a different
 * shape — and gum is a prompt per shape instead of a list pretending to be one.
 *
 * The questions and their order are the panel's, from `newTaskFlow.ts`: repos,
 * type, microservice, summary. Only `TASK_TYPES` is actually shared code (it
 * lives in `core/naming.ts` for that reason); the wording is deliberately not,
 * because a full-window wizard and a one-line popup header do not read the same.
 *
 * The fifth question is where this stops being a form. A goal is a paragraph,
 * and a paragraph typed into a `gum input` is a single scrolling line you cannot
 * reread — so instead of asking, the task is built with no goal and `$EDITOR` is
 * opened on its `TASK.md`, cursor on the line under `## Goal`. What you write
 * there is read back into `task.json` on exit (`syncGoalFromBrief`), which is
 * what keeps it from being erased the next time a repo joins and the brief is
 * regenerated. See the `GOAL_HEADING` comment in `core/task.ts`.
 */

export interface NewTaskOptions {
  /** Started in the task's session once the goal is written. */
  agent?: AgentTool | 'none';
}

export async function cmdNewTask(options: NewTaskOptions): Promise<void> {
  const names = (await repoIndex.getIndex()).repos.filter((r) => r.isRepo).map((r) => basename(r.path));
  if (names.length === 0) {
    fail('no git repositories under your project roots — check `fw doctor`');
    return;
  }

  // Repos first, for the reason `newTaskFlow.ts` gives: it is the answer that
  // decides whether the rest of the form was worth filling in, and the only one
  // you answer by recognising a name rather than composing one.
  const picked = await gum(
    ['filter', '--no-limit', '--height=14', '--header=which repos does this touch?', '--placeholder=filter repos…'],
    names,
  );
  const repos = picked.lines;
  // No re-asking here: a filter you escaped and a filter that matched nothing
  // both mean you are not starting this task after all.
  if (picked.code !== 0 || repos.length === 0) return cancelled();

  const chosen = await gum(
    ['choose', '--height=5', `--header=what kind of change is it? (${repos.join(', ')})`],
    [...TASK_TYPES],
  );
  const type = chosen.lines[0];
  if (chosen.code !== 0 || type === undefined) return cancelled();

  const microservice = await ask(
    ['input', '--header=which microservice?', '--placeholder=e.g. flow — a domain, not a repo'],
    (answer) => slugify(answer).length > 0,
  );
  if (microservice === undefined) return cancelled();

  const summary = await ask(
    [
      'input',
      // The branch so far, so the last question is asked with the thing it
      // completes visible — `feature/flow-…` is a different promise than
      // `feature/flow`, which is `previewBranch`'s point in the panel.
      `--header=summarise it  →  ${buildBranch(type, microservice, '')}-…`,
      '--placeholder=e.g. execution labels',
    ],
    (answer) => slugify(answer).length > 0,
  );
  if (summary === undefined) return cancelled();

  const branch = buildBranch(type, microservice, summary);
  process.stdout.write(`${c.bold('branch')} ${c.warn(branch)}\n`);

  /*
   * `background` so the session is made but not switched to: the popup is still
   * open and about to run an editor in it, and a `switch-client` underneath that
   * leaves you looking at the new session with a stray nvim over the top of it.
   * The focus happens at the end, once the goal is in.
   */
  const result = await taskApi.createTask({
    type,
    microservice,
    summary,
    repos,
    agent: 'none',
    background: true,
  });

  for (const r of result.repoResults) {
    process.stdout.write(`${r.ok ? c.ok('✓') : c.danger('✗')} ${r.repo} ${c.muted(r.detail)}\n`);
  }
  if (!result.ok || !result.task) {
    fail(result.detail);
    return;
  }

  const task = result.task;
  const edited = await editGoal(task.dir);
  if (edited) {
    const synced = await taskApi.syncGoalFromBrief(task.slug);
    process.stdout.write(`${synced.ok ? c.ok('✓') : c.danger('✗')} ${synced.detail}\n`);
  }

  // Only now, and only if asked: creating a task and choosing what runs in it
  // are two decisions — see `CreateTaskInput.agent`.
  const agent = options.agent ?? 'none';
  if (agent !== 'none') {
    // The same shape `createTask` would have used, so an agent asked for here
    // lands in the window it would have landed in there.
    const spawned = await actions.spawnAgent({
      session: task.session ?? task.slug,
      tool: agent,
      cwd: task.dir,
      windowName: 'task',
      reuseWindow: true,
    });
    process.stdout.write(`${spawned.ok ? c.ok('✓') : c.danger('✗')} ${spawned.detail}\n`);
  }

  process.stdout.write(`${c.muted(tildify(task.dir))}\n`);
  if (task.session) await actions.focusSession(task.session);
}

/**
 * Open the brief where the goal goes, and say whether it was worth reading back.
 *
 * `false` when there is no editor to run or it could not start — the task is
 * already made and its session is about to be focused, so a missing `$EDITOR`
 * costs you the goal, not the task.
 */
async function editGoal(dir: string): Promise<boolean> {
  const brief = join(dir, 'TASK.md');
  const editor = process.env.EDITOR?.trim() || 'nvim';

  let line = 1;
  try {
    line = taskApi.briefGoalLine(await readFile(brief, 'utf8'));
  } catch {
    return false;
  }

  const [command, ...rest] = editor.split(/\s+/);
  if (command === undefined) return false;

  return new Promise((resolve) => {
    const child = spawn(command, [...rest, ...editorArgs(command, line), brief], { stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) => {
      process.stderr.write(
        error.code === 'ENOENT'
          ? `${c.danger('✗')} ${command} is not on PATH — the task is made, its goal is not\n`
          : `${c.danger('✗')} could not run ${command}: ${error.message}\n`,
      );
      resolve(false);
    });
    // Read the file back whatever the editor exited with: `:cq` is a deliberate
    // non-zero, and a crash after a write still leaves the text on disk.
    child.on('close', () => resolve(true));
  });
}

/**
 * How to say "open on this line" to the editor you actually have.
 *
 * `+N` is the vi and emacs spelling and covers what anyone reaching for
 * `$EDITOR` in a tmux popup is running. Anything else gets the file alone rather
 * than a flag it will treat as a second filename and create.
 */
export function editorArgs(command: string, line: number): string[] {
  const name = basename(command);
  const understands = ['nvim', 'vim', 'vi', 'view', 'nano', 'emacs', 'emacsclient', 'kak'];
  return understands.includes(name) ? [`+${line}`] : [];
}

/**
 * One gum prompt. gum draws on stderr and prints the answer on stdout, which is
 * what lets stdout be a pipe here while the TUI finds the popup's own tty.
 *
 * The exit code comes back with the lines because the two ways of answering
 * nothing are different: escape (non-zero) abandons the form, and submitting an
 * empty field (zero) is a question that still needs an answer. Collapsing them
 * threw away a form you had half filled in because you hit Enter too early.
 */
async function gum(
  args: readonly string[],
  stdin?: readonly string[],
): Promise<{ code: number; lines: string[] }> {
  const styled = [...args, ...gumColors(args[0])];
  return new Promise((resolve) => {
    const child = spawn('gum', styled, {
      stdio: [stdin === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'] as const,
    });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      process.stderr.write(
        error.code === 'ENOENT'
          ? `${c.danger('✗')} gum is not on PATH — brew install gum\n`
          : `${c.danger('✗')} could not run gum: ${error.message}\n`,
      );
      process.exitCode = 1;
      resolve({ code: 1, lines: [] });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        lines: out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      });
    });
    if (stdin !== undefined) child.stdin?.end(stdin.join('\n'));
  });
}

/**
 * The theme, in the flags the subcommand in hand actually has.
 *
 * gum rejects a flag its subcommand does not define, so these are per-command
 * rather than one list — the same reason `fzfColors` can be one string and this
 * cannot. `--header` is on all three; the rest are not.
 */
export function gumColors(subcommand: string | undefined): string[] {
  const p = currentPalette();
  // `--header` is the only one all three define. `filter` in particular has no
  // `--cursor.foreground` — it draws a prompt, not a pointer — and passing it
  // one is a form that exits before its first question is on screen.
  const header = `--header.foreground=${p.dim}`;
  switch (subcommand) {
    case 'filter':
      return [
        header,
        `--prompt.foreground=${p.accent}`,
        `--match.foreground=${p.accent}`,
        `--placeholder.foreground=${p.dim}`,
        `--text.foreground=${p.text}`,
      ];
    case 'choose':
      return [
        header,
        `--cursor.foreground=${p.accent}`,
        `--selected.foreground=${p.accent}`,
        `--item.foreground=${p.soft}`,
      ];
    case 'input':
      return [
        header,
        `--cursor.foreground=${p.accent}`,
        `--prompt.foreground=${p.accent}`,
        `--placeholder.foreground=${p.dim}`,
      ];
    default:
      return [header];
  }
}

/**
 * Ask until there is an answer, or until escape says there will not be.
 *
 * `undefined` means the form was abandoned; an empty submit just asks again,
 * which is this form's version of the panel's `canAdvance` — every question but
 * the goal is required, and the goal is not asked here at all.
 */
async function ask(
  args: readonly string[],
  valid: (answer: string) => boolean,
): Promise<string | undefined> {
  for (;;) {
    const { code, lines } = await gum(args);
    if (code !== 0) return undefined;
    const answer = lines[0];
    if (answer !== undefined && valid(answer)) return answer;
  }
}

function cancelled(): void {
  // Nothing was created and nothing is wrong: the popup just closes.
  process.stdout.write(`${c.muted('cancelled')}\n`);
}

function fail(detail: string): void {
  process.stderr.write(`${c.danger('✗')} ${detail}\n`);
  process.exitCode = 1;
}
