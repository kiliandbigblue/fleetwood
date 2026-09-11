import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actions,
  buildFleet,
  buildSwitchTargets,
  repoIndex,
  task as taskApi,
} from '@fleetwood/core';
import type { ActionResult, FleetAgent, SwitchTarget, TaskRepo } from '@fleetwood/core';
import { worktreeShortName } from '@fleetwood/core/naming';
import { agentAge, renderAgentLine, statusChip } from './render.ts';
import { c, charWidth, clipWidth, currentPalette, pad, relativeAge, tildify, width } from './ui.ts';

/*
 * `fw switch` — what `prefix+g` runs.
 *
 * The picker is fzf, and deliberately: the binding it replaces was already
 * `find | fzf` in a `display-popup`, so the matching, the keys and the popup
 * behaviour are the parts nobody has to learn again. What fleetwood adds is the
 * list — the fleet as the panel shows it, agent status included, down to the
 * pane one agent is blocked in.
 *
 * fzf is fed and read over pipes and finds its own terminal on /dev/tty, so this
 * is one process rather than a shell script: the selection is acted on here,
 * with the same `actions` the app's buttons call.
 */

/**
 * The temp directories are named so a previous run's can be recognised.
 *
 * The `finally` below removes this run's, and covers every ordinary exit — a
 * pick, an escape, fzf missing. What it cannot cover is the popup being closed
 * out from under it (`kill-session`, a `SIGHUP` on the client), which leaves one
 * empty directory behind; `sweepStale` is what stops those accumulating for
 * months rather than being a second cleanup path for the same case.
 */
const PREVIEW_PREFIX = 'fw-switch-';

/** Where fzf reads previews from: one file per row, named by its index. */
interface Previews {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface SwitchOptions {
  capture: boolean;
  all?: boolean;
  json?: boolean;
  /** Print the lines it would hand fzf and exit, for reading the layout. */
  list?: boolean;
  /**
   * The projects browser: every directory under the roots, and nothing else.
   *
   * `prefix+g` is the fleet and `prefix+G` is this, because they answer
   * different questions and only one of them is asked all day. The old binding
   * offered sixty directories to get at eight live sessions, and a fuzzy match
   * over the work you are doing is worth more than one over everything you have
   * ever cloned. Nothing is lost, it is one shift away — and this mode pays for
   * neither a fleet scan nor a git read, so it opens instantly.
   */
  projects?: boolean;
}

export async function cmdSwitch(options: SwitchOptions): Promise<void> {
  const projectsOnly = options.projects === true;
  // Each key fetches only what its own list is made of: the fleet picker never
  // walks the project roots, and the projects browser never scans the fleet.
  const [fleet, tasks, projects] = await Promise.all([
    projectsOnly ? undefined : buildFleet({ capture: options.capture }),
    projectsOnly ? [] : taskApi.listTasks(),
    projectsOnly ? repoIndex.getIndex().then((index) => index.repos) : [],
  ]);

  const targets = buildSwitchTargets({
    sessions: fleet?.sessions ?? [],
    tasks,
    projects,
    all: options.all,
    hostname: hostname(),
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        targets.map((t) => ({
          kind: t.kind,
          tier: t.tier,
          ref: t.ref,
          label: t.label,
          status: t.agent?.status,
          branch: t.branch,
          path: t.path,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const rows = renderRows(targets);
  if (options.list) {
    process.stdout.write(`${rows.join('\n')}\n`);
    return;
  }
  if (targets.length === 0) {
    process.stdout.write(`${c.muted('nothing to switch to — no sessions, tasks or projects')}\n`);
    return;
  }

  /*
   * The projects browser gets no preview pane.
   *
   * There is nothing to put in one: a directory with no session has a path and
   * a remote, and both fit on the row. A pane showing two lines beside a column
   * of names is a narrower list for no information, and skipping it means
   * skipping the files too.
   */
  const previews = projectsOnly ? undefined : await writePreviews(targets);
  try {
    const chosen = await runFzf(rows, previews?.dir, targets);
    // Escape, or fzf not there at all: both mean "carry on where you were", and
    // the popup closing is all the answer needed.
    if (chosen === undefined) return;
    const target = targets[chosen];
    if (!target) return;
    const result = await act(target);
    process.stdout.write(`${result.ok ? c.ok('✓') : c.danger('✗')} ${result.detail}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await previews?.cleanup();
  }
}

/** Do what the row promised. One `actions` call each, the same the panel makes. */
async function act(target: SwitchTarget): Promise<ActionResult> {
  switch (target.kind) {
    case 'session':
      return actions.focusSession(target.ref);
    case 'agent':
      return actions.focusPane(target.ref);
    case 'task': {
      // A dormant task has no session to switch to, so one is made first —
      // `startTaskSession` focuses it itself, and leaves it at a shell.
      const result = await taskApi.startTaskSession(target.ref);
      return { ok: result.ok, detail: result.detail };
    }
    case 'project':
      return actions.openProject({ path: target.ref });
  }
}

// --- rows ------------------------------------------------------------------

/*
 * The columns.
 *
 * Capped rather than measured, because the widest row here is not
 * representative of the list: one task called
 * `receive-receive-item-into-rebin-or-mono-item` would push every status chip
 * forty characters to the right and leave the other twenty rows reading as a
 * column of names with nothing beside them. A name that does not fit is
 * clipped, and the preview pane carries the whole of it.
 */
const NAME = 30;
/** `✋ permission` at two cells for the glyph — the longest chip there is. */
const STATE = 13;
/** `×3`, and two cells of nothing on the rows that have no more to count. */
const COUNT = 2;
/** `4 wt · 1d`, or an agent's age. Padded, so the tail starts in one place. */
const META = 11;
/**
 * The column that ends a row, capped to what the list half of the popup
 * holds — about 86 columns of an 88% popup with the preview beside it. Past
 * that fzf clips the line itself, which is fine but says nothing about which
 * part of it mattered.
 */
const TAIL = 26;

/**
 * One row per target, as `<index>\t<what you read>`.
 *
 * The index leads because the selection has to come back as something exact: a
 * pane id parsed back out of a painted, clipped line is a bug waiting for a
 * session called `%7`. fzf is told to display from field 2 on, which makes the
 * number unsearchable for free — with `--with-nth` the search space *is* the
 * transformed line.
 *
 * That same rule is why there is no hidden column here. A tab-separated field
 * of repo names and slugs, displayed to nobody and matched by everything, is
 * the obvious way to make `proto` find the task that touches proto — and fzf
 * says so plainly: *it doesn't allow searching against the hidden fields*. So
 * what a row can be found by is exactly what it shows, and the answer to
 * wanting the repos searchable was to give them a column (see `tail`).
 */
export function renderRows(targets: readonly SwitchTarget[]): string[] {
  return targets.map((target, index) => {
    // Trailing space is padding for a column this row left empty — a branch it
    // does not need, an activity it never reported. fzf highlights the whole
    // line, so it would show as a bar of blank cells past the end of the text.
    return `${index}\t${renderRow(target).trimEnd()}`;
  });
}

/**
 * What to call an agent row.
 *
 * The agent's own title first — it is the only label here written by the thing
 * being described, and `Chronopost Label Test` is what you would actually type
 * to find it again. `3:claude` is the fallback and says something different but
 * useful: which window picking this lands you in. Never both, because the tool
 * is already in the row's colour and the window is in the preview.
 */
function agentSlot(target: SwitchTarget): string {
  if (target.title) return target.title;
  const window = target.window ? `${target.window.index}:` : '';
  return `${window}${target.agent?.tool ?? 'agent'}`;
}

/**
 * The five cells every row has, whatever kind of row it is.
 *
 * One shape for all four kinds, because the alternative is what this list had:
 * each kind assembled its own line, and an agent row — no count column, a
 * six-wide age where a session had an eleven-wide meta — put its last column
 * seven cells left of the session rows either side of it. A picker is read down
 * its columns, so the columns have to exist before the rows do.
 *
 * Every cell arrives clipped, padded and painted: a colour closes with a reset,
 * so measuring one after painting it means measuring the escapes too.
 */
interface Cells {
  /** The one-cell glyph: `●` attached, `○` not, `◦` dormant, `+` new, `↳` agent. */
  mark: string;
  /** Whether the `✋` gutter is lit — sessions only; an agent's chip says it. */
  attention: boolean;
  name: string;
  /** Status chip and the `×3` count beside it, as one padded pair. */
  state: string;
  meta: string;
  tail: string;
}

function renderRow(target: SwitchTarget): string {
  const cells =
    target.kind === 'agent' && target.agent
      ? agentCells(target, target.agent)
      : target.kind === 'project'
        ? projectCells(target)
        : target.kind === 'task'
          ? taskCells(target)
          : sessionCells(target);
  return `${cells.mark} ${gutter(cells.attention)}${cells.name} ${cells.state} ${cells.meta} ${cells.tail}`;
}

/**
 * An agent, under the session holding it.
 *
 * Its age goes in the session rows' meta column rather than a narrower one of
 * its own, and the count column it has nothing to put in is held open — that is
 * what keeps one agent's activity in line with its session's repos.
 */
function agentCells(target: SwitchTarget, agent: FleetAgent): Cells {
  return {
    mark: c.dim('↳'),
    attention: false,
    name: c.muted(clipPad(agentSlot(target), NAME)),
    state: `${statusChip(agent.status, STATE)}${clipPad('', COUNT)}`,
    meta: c.muted(clipPad(agentAge(agent), META)),
    tail: agentTail(agent),
  };
}

function sessionCells(target: SwitchTarget): Cells {
  return {
    mark: target.attached ? c.ok('●') : c.muted('○'),
    attention: target.needsAttention === true,
    name: c.bold(clipPad(target.label, NAME)),
    state: sessionState(target),
    meta: meta(target),
    tail: tail(target),
  };
}

function taskCells(target: SwitchTarget): Cells {
  return {
    mark: c.muted('◦'),
    attention: false,
    name: c.bold(clipPad(target.label, NAME)),
    state: c.muted(clipPad('dormant', STATE + COUNT)),
    meta: meta(target),
    tail: tail(target),
  };
}

function projectCells(target: SwitchTarget): Cells {
  return {
    mark: c.dim('+'),
    attention: false,
    name: c.bold(clipPad(target.label, NAME)),
    // Not a session yet, and the row says which of the two it is about to
    // become rather than leaving the `+` to carry it alone.
    state: c.muted(clipPad('new session', STATE + COUNT)),
    // Nothing has been created, so there is no age and no worktree count. The
    // column stays open: a project row sits among session rows.
    meta: clipPad('', META),
    tail: c.muted(clip(tildify(parent(target.path ?? '')), TAIL)),
  };
}

/**
 * What an agent row ends on, when it has anything to say.
 *
 * Two things used to land here that were not worth the widest column in the
 * list. A blocked agent's activity is Claude Code's own notification text —
 * `Claude needs your permission` — which is the chip two columns to the left,
 * spelled out; what you actually want before jumping into that pane is the
 * question, so the prompt's own text goes here and the restatement goes
 * nowhere. And a working agent's activity is mostly a command, clipped from the
 * right, which is the end that carries the meaning: `Bash: cd ~/projects/.age…`
 * is thirty cells spent telling you an agent ran `cd`. Clipped from the middle
 * now, so the tool and the target both survive.
 */
function agentTail(agent: FleetAgent): string {
  if (agent.status === 'blocked_permission' || agent.status === 'blocked_input') {
    const question = agent.prompt?.question;
    return question ? c.warn(clip(question, TAIL)) : '';
  }
  if (!agent.activity) return '';
  return c.dim(clipMiddle(shorten(agent.activity), TAIL));
}

/**
 * The last column: the branch when it says something, otherwise the repos.
 *
 * A task's branch *is* `<type>/<slug>` by the naming convention, so printing it
 * beside the slug spends the widest column in the list restating the word you
 * just read. What is worth that space instead is which repos the task touches —
 * which is also the thing you are most likely to type, since what you remember
 * about a task is often `proto` rather than the slug you gave it. It has to be
 * *shown* to be searchable at all (see `renderRows`), and that is no loss:
 * `3 wt · proto graphy` answers the question `3 wt` only counted.
 *
 * What is left in the branch's own case is the branch the name does not already
 * give you: a PR session's `fix/address-validation`, or a stack layer.
 */
function tail(target: SwitchTarget): string {
  const branch = target.branch;
  if (branch && !branch.endsWith(`/${target.label}`) && branch !== target.label) {
    return c.branch(clip(branch, TAIL));
  }
  const repos = target.task?.repos ?? [];
  if (repos.length === 0) return '';
  const slug = target.task?.slug ?? '';
  const names = [...new Set(repos.map((repo) => repoName(repo, slug)).filter(Boolean))];
  return c.dim(clip(names.join(' '), TAIL));
}

/**
 * The two characters in front of the name.
 *
 * A `✋` and nothing else, because it is the only thing in this list worth
 * pulling your eye off the name you are typing — and it holds its space on
 * every row so the names stay in one column whether anything is blocked or not.
 */
function gutter(attention: boolean): string {
  // `✋` is two cells wide on its own, so it needs no space after it to match
  // the two this returns when nothing is blocked. Adding one is what pushed
  // every blocked session's name a column right of all the others.
  return attention ? c.danger('✋') : '  ';
}

/**
 * What the session is doing, in one chip.
 *
 * The lead agent is the most urgent one, since that is the only per-agent fact
 * a one-line row has room for; the count says how many more there are without
 * pretending to say what each is doing. A session with no agent gets its pane
 * count instead — "nothing running here" is the useful fact about it, and the
 * difference between a session to jump into and one to start something in.
 */
function sessionState(target: SwitchTarget): string {
  const lead = target.lead;
  if (!lead) {
    const panes = target.panes ?? 0;
    return c.dim(clipPad(`${panes} pane${panes === 1 ? '' : 's'}`, STATE + COUNT));
  }
  const count = (target.agentCount ?? 1) > 1 ? `×${target.agentCount}` : '';
  return `${statusChip(lead.status, STATE)}${c.accent(clipPad(count, COUNT))}`;
}

/** The dim tail: how many worktrees, and how long it has been around. */
function meta(target: SwitchTarget): string {
  const parts = [
    target.task ? `${target.task.repos.length} wt` : '',
    target.createdAt ? relativeAge(target.createdAt) : '',
  ].filter(Boolean);
  return c.dim(clipPad(parts.join(' · '), META));
}


/**
 * `$HOME` written as `~` wherever it appears, not only at the front.
 *
 * `tildify` collapses a path; an activity line is a *command*, and the home
 * directory turns up in the middle of it — `Shell: cd /Users/<name>/projects/…`
 * spends a third of the column on something every row shares.
 */
function shorten(text: string): string {
  return text.replaceAll(homedir(), '~');
}

/**
 * What to call one worktree of a task, in one word.
 *
 * `owner/` off the front, because it is the same on all of them. Failing a
 * remote, the directory — through the panel's own `worktreeShortName`, which
 * takes off the task's slug and nothing else: a stack is several worktrees of
 * one repo named for their own branches, and stripping those would render five
 * different layers as five rows reading `reflow`.
 */
function repoName(repo: TaskRepo, taskSlug: string): string {
  if (repo.repo) return repo.repo.split('/').pop() ?? repo.repo;
  return worktreeShortName(repo.name, taskSlug);
}

function parent(path: string): string {
  const at = path.lastIndexOf('/');
  return at > 0 ? path.slice(0, at) : path;
}

/** Clip to `n` cells, marking that something was taken off. */
function clip(text: string, n: number): string {
  return clipWidth(text, n);
}

/**
 * Keep both ends of a label and drop the middle.
 *
 * For activity lines, which are a tool name and then a command: `Bash: ` is the
 * half you can read in one glance and the argument's own end is the half that
 * says which command it was. Clipping from the right keeps the first of those
 * and throws away the second, which on a row of `cd ~/projects/.agents/tasks/…`
 * leaves nothing but boilerplate.
 */
function clipMiddle(text: string, n: number): string {
  if (width(text) <= n) return text;
  const at = text.indexOf(': ');
  const head = at > 0 && at + 2 < n / 2 ? text.slice(0, at + 2) : '';
  const room = n - width(head) - 1;
  if (room <= 0) return clipWidth(text, n);
  let out = '';
  let used = 0;
  // From the end, so what survives is the end.
  for (const char of [...text.slice(head.length)].reverse()) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (used + w > room) break;
    out = char + out;
    used += w;
  }
  return `${head}…${out}`;
}

/** Clip, then pad — painting happens after, since a colour closes with a reset. */
function clipPad(text: string, n: number): string {
  return pad(clip(text, n), n);
}

// --- previews ---------------------------------------------------------------

/**
 * A file per row, so the preview costs nothing to show.
 *
 * The obvious `--preview 'fw switch --preview {1}'` would pay a node start and
 * a fresh `buildFleet` per keystroke, for a picture of a fleet this process
 * already has in hand. Writing the panes out once and pointing fzf at `cat` is
 * the same content, rendered from the same snapshot the rows were.
 */
async function writePreviews(targets: readonly SwitchTarget[]): Promise<Previews> {
  await sweepStale();
  const dir = await mkdtemp(join(tmpdir(), PREVIEW_PREFIX));
  await Promise.all(
    targets.map((target, index) => writeFile(join(dir, String(index)), renderPreview(target), 'utf8')),
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Preview directories an earlier run was killed before it could remove. */
async function sweepStale(): Promise<void> {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(PREVIEW_PREFIX))
      .map((entry) => rm(join(root, entry), { recursive: true, force: true })),
  );
}

/** What the row expands into: the session's agents, or the task's worktrees. */
export function renderPreview(target: SwitchTarget): string {
  const lines: string[] = [];
  const task = target.task;

  const heading =
    target.kind === 'project'
      ? `${c.bold(target.label)} ${c.muted('· no session yet')}`
      : target.kind === 'task'
        ? `${c.bold(target.label)} ${c.muted('· task, no session')}`
        : `${c.bold(target.label)}${target.attached ? c.ok(' · attached') : ''}`;
  lines.push(heading);
  if (target.branch) lines.push(c.branch(target.branch));
  if (target.path) lines.push(c.muted(tildify(target.path)));
  lines.push('');

  if (target.kind === 'agent' && target.agent) {
    lines.push(
      c.muted(`window ${target.window ? `${target.window.index}:${target.window.name}` : '—'}`),
    );
    lines.push(renderAgentLine(target.agent, ''));
    // The prompt an agent is blocked on is the reason to jump to it, so it is
    // what the preview leads with rather than a summary of it.
    const prompt = target.agent.prompt;
    if (prompt?.question) {
      lines.push('');
      lines.push(c.warn(prompt.question));
      for (const option of prompt.options) lines.push(c.muted(`  ${option.key}  ${option.label}`));
    }
    lines.push('');
  } else if (target.kind === 'session') {
    if (target.lead) {
      lines.push(c.muted(`${target.agentCount} agent${target.agentCount === 1 ? '' : 's'}`));
      // Only the lead is carried on the row; the whole roster is what a preview
      // is for. Rendered with the fleet list's own agent line, so nothing here
      // is a second opinion about a status.
      lines.push(renderAgentLine(target.lead, '  '));
      lines.push('');
    } else {
      lines.push(c.dim(`no agents · ${target.panes} pane${target.panes === 1 ? '' : 's'}`));
      lines.push('');
    }
  }

  if (task) {
    lines.push(c.muted(`${task.type} · ${task.microservice}`));
    if (task.summary) lines.push(task.summary);
    lines.push('');
    for (const repo of task.repos) {
      const dirty = repo.dirty > 0 ? c.warn(` ${repo.dirty} dirty`) : '';
      lines.push(`  ${repo.name}${repo.branch ? c.branch(` ${repo.branch}`) : ''}${dirty}`);
    }
    if (task.goal) {
      lines.push('');
      lines.push(c.muted('goal'));
      lines.push(task.goal);
    }
    if (task.notes) {
      lines.push('');
      lines.push(c.muted('notes'));
      lines.push(task.notes.trim());
    }
  }

  return `${lines.join('\n')}\n`;
}

// --- fzf --------------------------------------------------------------------

/**
 * fzf's own chrome, in the configured fleetwood theme.
 *
 * The rows arrive painted, so what is left to colour is everything around them
 * — prompt, pointer, current line, match highlights, border, header — and
 * left alone that comes out in fzf's default blues and greens inside a
 * rosé-pine terminal. Same eleven roles as `fw status`, so this popup and the
 * panel beside it are the same colour by construction, not by coincidence.
 *
 * `-1` twice, deliberately: `bg` keeps the terminal's own background (the popup
 * is transparent by `popup-style bg=default` in .tmux.conf, and painting a fill
 * here would undo that), and `fg+` keeps each row's own colours on the selected
 * line instead of flattening a red `✋ permission` to the cursor's foreground.
 */
function fzfColors(): string {
  const p = currentPalette();
  return [
    'bg:-1',
    `fg:${p.soft}`,
    'fg+:-1',
    `bg+:${p.panel}`,
    `hl:${p.accent}`,
    `hl+:${p.accent}`,
    `pointer:${p.accent}`,
    `prompt:${p.accent}`,
    `marker:${p.accent}`,
    `spinner:${p.accent}`,
    `info:${p.dim}`,
    `header:${p.dim}`,
    `border:${p.edge}`,
    `label:${p.dim}`,
  ].join(',');
}

/**
 * Run fzf over the rows and hand back the index of the one picked.
 *
 * `undefined` for every way of not choosing, including fzf being absent: this
 * runs inside a tmux popup that closes the moment it returns, so the only
 * useful thing a failure can do is say so on the way out.
 */
async function runFzf(
  rows: readonly string[],
  previewDir: string | undefined,
  targets: readonly SwitchTarget[],
): Promise<number | undefined> {
  const live = targets.filter((t) => t.kind === 'session').length;
  const agents = targets.filter((t) => t.kind === 'agent').length;
  const dormant = targets.filter((t) => t.kind === 'task').length;
  const projects = targets.filter((t) => t.kind === 'project').length;
  const header = (
    projects > 0
      ? [`${projects} project${projects === 1 ? '' : 's'}`, 'prefix+g for the fleet']
      : [
          `${live} session${live === 1 ? '' : 's'}`,
          agents > 0 ? `${agents} agent${agents === 1 ? '' : 's'}` : '',
          dormant > 0 ? `${dormant} dormant` : '',
          // The tier that is no longer here, and the key that has it. A list
          // that silently stopped offering something needs to say where it went.
          'prefix+G for all projects',
        ]
  )
    .filter(Boolean)
    .join(' · ');

  const args = [
    '--ansi',
    '--delimiter=\t',
    // Field 1 is the row's index: displayed to nobody, and unsearchable for
    // free, since `--with-nth` makes the transformed line the search space too.
    '--with-nth=2..',
    '--no-multi',
    '--layout=reverse',
    '--info=inline-right',
    '--prompt=switch › ',
    '--pointer=▸',
    '--marker=▸',
    // fzf fills the pointer column of every other row with `▌` by default, and
    // there is nothing for it to mean in a single-select list: it reads as a
    // stray glyph in front of each name, or as a second pointer.
    '--gutter= ',
    '--ellipsis=…',
    `--header=${header}`,
    '--header-first',
    // Ties go to the order the fleet was already in — urgency first, then the
    // slots you put the sessions in. fzf's default breaks them on line length,
    // which would sort by how long a branch name is.
    '--tiebreak=begin,index',
    '--cycle',
    '--scroll-off=3',
    '--no-scrollbar',
    `--color=${fzfColors()}`,
  ];

  if (previewDir !== undefined) {
    args.push(
      `--preview=cat ${previewDir}/{1}`,
      // Beside the list, and unconditionally. fzf 0.72 honours a width
      // condition (`right,48%,<110(down,45%)`) whether the width matches or
      // not, so the spec meant to stack the preview under a *narrow* terminal
      // stacked it under a 170-column one as well — and a preview is only
      // worth having where there is room for two columns of text beside
      // each other.
      '--preview-window=right,48%,border-left,wrap',
      '--bind=ctrl-/:toggle-preview',
    );
  }

  return new Promise((resolve) => {
    const child = spawn('fzf', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      process.stderr.write(
        error.code === 'ENOENT'
          ? `${c.danger('✗')} fzf is not on PATH — brew install fzf\n`
          : `${c.danger('✗')} could not run fzf: ${error.message}\n`,
      );
      process.exitCode = 1;
      resolve(undefined);
    });
    child.on('close', (code) => {
      // 130 is escape or ctrl-c; 1 is enter on a query that matched nothing.
      if (code !== 0) return resolve(undefined);
      const index = Number.parseInt(out.split('\t')[0] ?? '', 10);
      resolve(Number.isInteger(index) ? index : undefined);
    });
    child.stdin.end(rows.join('\n'));
  });
}
