import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { run } from './exec.ts';
import { FW_HOME } from './paths.ts';
import type { Palette } from './theme.ts';
import type { FleetSession } from './fleet.ts';
import { agentDiff, indexTree, mergeBase, snapshotTree, wholeDiff } from './tourDiff.ts';
import type { FileDiff } from './tourDiff.ts';
import { RECAP_SCHEMA, checkRecap, plainDiff, recapPrompt } from './tourRecap.ts';
import type { Recap } from './tourRecap.ts';
import { tourPage } from './tourPage.ts';

export const TOURS_DIR = join(FW_HOME, 'tours');

/** Read-only: the recap agent looks around the repo and never touches it. */
const AGENT_TOOLS = 'Read,Grep,Glob';
/** Sonnet, not the user's default: a recap is reading, and Opus is slow at it. */
const AGENT_MODEL = 'sonnet';
const BUILD_MS = 15 * 60_000;
const ASK_MS = 5 * 60_000;

export interface TourComment {
  id: string;
  section: number;
  path?: string;
  /** Row index in that file's diff. */
  row?: number;
  /**
   * A question is for understanding and is answered here by the agent; a
   * concern is something to fix and goes to the author.
   */
  kind: 'question' | 'concern';
  body: string;
  answer?: string;
  /** The answer is being written. */
  asking?: boolean;
  /** When the agent was last asked, so the page can say how long it has been reading. */
  askedAt?: number;
  /** The answer is an error, not an answer: the page offers to ask again. */
  failed?: boolean;
  /** A raised question's own words, kept with the answer it got. */
  asked?: string;
  /** A concern that reached the agent; it stays, but is not sent twice. */
  sent?: boolean;
}

/** Everything one review keeps, under its snapshot's key. */
export interface TourState {
  cwd: string;
  base: string;
  /** Where the diff starts: the merge base with `base`, or the index's tree for an unstaged review. */
  from: string;
  tree: string;
  status: 'building' | 'ready' | 'error';
  /** When the current build started, so the page can say how long it has run. */
  startedAt?: number;
  error?: string;
  /** The recap agent's session; questions resume a fork of it. */
  session?: string;
  recap?: Recap;
  checked: number[];
  comments: TourComment[];
}

export interface SendOutcome {
  ok: boolean;
  detail: string;
  /** The prompt, for the page to put on the clipboard when no pane took it. */
  clipboard?: string;
}

export interface Concern {
  path: string;
  line: number;
  side: 'new' | 'old';
  code: string;
  body: string;
  /** What the reviewer asked about this line before raising it, and what the agent answered. */
  asked?: { question: string; answer: string };
}

export interface TourOptions {
  cwd: string;
  /** The ref to diff against; the merge base with HEAD is what is shown. */
  base: string;
  /** Only what is not staged yet: the index against the worktree, so the agent's latest edits. */
  unstaged?: boolean;
  /** Hand concerns to the agent. Asked at click time: the agent may have changed since. */
  send: (concerns: Concern[]) => Promise<SendOutcome>;
}

interface Open extends TourOptions {
  key: string;
  files: FileDiff[];
}

const tours = new Map<string, Open>();
const states = new Map<string, TourState>();
const saving = new Map<string, Promise<void>>();

const stateFile = (key: string): string => join(TOURS_DIR, `${key}.json`);

async function loadState(key: string): Promise<TourState | undefined> {
  const cached = states.get(key);
  if (cached) return cached;
  try {
    const state = JSON.parse(await readFile(stateFile(key), 'utf8')) as TourState & { mergeBase?: string };
    // Kept before `from` was named for what it is; drop once reviews from before the rename are gone.
    state.from ??= state.mergeBase as string;
    delete state.mergeBase;
    // A build or an answer that was running when the app quit never finishes.
    if (state.status === 'building') {
      state.status = 'error';
      state.error = 'the recap was interrupted';
    }
    for (const c of state.comments) {
      if (!c.asking) continue;
      delete c.asking;
      c.answer = 'Could not answer: fleetwood quit before the answer came.';
      c.failed = true;
    }
    states.set(key, state);
    return state;
  } catch {
    return undefined;
  }
}

/** Writes are chained per key, so two quick checkoffs never interleave on disk. */
function save(key: string): Promise<void> {
  const state = states.get(key);
  if (!state) return Promise.resolve();
  const next = (saving.get(key) ?? Promise.resolve()).then(async () => {
    await mkdir(TOURS_DIR, { recursive: true });
    await writeFile(stateFile(key), JSON.stringify(state, null, 2), 'utf8');
  });
  saving.set(key, next.catch(() => undefined));
  return next;
}

/** What `claude -p` printed, read off its JSON envelope. */
interface ClaudeResult {
  session_id?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

function claude(cwd: string, args: string[], prompt: string, timeoutMs: number): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', AGENT_MODEL, '--tools', AGENT_TOOLS, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      const enoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(enoent ? 'claude is not on PATH' : error.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`claude was stopped (${signal}) — it took longer than ${timeoutMs / 60_000} min`));
      try {
        const result = JSON.parse(out) as ClaudeResult;
        if (result.is_error) return reject(new Error(`claude: ${result.result ?? 'failed'}`));
        resolve(result);
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 500) || 'without output'}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function build(tour: Open, state: TourState): Promise<void> {
  try {
    const result = await claude(
      tour.cwd,
      ['--json-schema', JSON.stringify(RECAP_SCHEMA)],
      recapPrompt(agentDiff(tour.files), against(tour)),
      BUILD_MS,
    );
    const recap = result.structured_output as Recap | undefined;
    if (!recap?.sections) throw new Error('claude returned no recap');
    checkRecap(recap, tour.files);
    state.recap = recap;
    state.session = result.session_id;
    state.status = 'ready';
  } catch (error) {
    state.status = 'error';
    state.error = (error as Error).message;
  }
  await save(tour.key);
}

/** What a review's diff is against, as the page and the prompt say it. */
export function against(options: Pick<TourOptions, 'base' | 'unstaged'>): string {
  return options.unstaged ? 'the index' : options.base;
}

/** Both ends of the diff: where it starts from, and the worktree as it stands. */
function pin(options: TourOptions): Promise<[string, string]> {
  const from = options.unstaged ? indexTree(options.cwd) : mergeBase(options.cwd, options.base);
  return Promise.all([from, snapshotTree(options.cwd)]);
}

/** Pin the worktree as it stands, and start its recap unless one is kept for it. */
async function prepare(options: TourOptions): Promise<Open> {
  const [from, tree] = await pin(options);
  const key = `${from.slice(0, 12)}-${tree.slice(0, 12)}`;
  const files = await wholeDiff(options.cwd, from, tree);
  if (files.length === 0) throw new Error(`nothing to review in ${basename(options.cwd)} against ${against(options)}`);
  const tour: Open = { ...options, key, files };
  tours.set(key, tour);

  const kept = await loadState(key);
  if (!kept || kept.status === 'error') {
    const state: TourState = {
      cwd: options.cwd,
      base: options.base,
      from,
      tree,
      status: 'building',
      startedAt: Date.now(),
      checked: kept?.checked ?? [],
      comments: kept?.comments ?? [],
    };
    states.set(key, state);
    void build(tour, state);
  }
  return tour;
}

async function ask(tour: Open, state: TourState, comment: TourComment): Promise<void> {
  comment.asking = true;
  comment.askedAt = Date.now();
  delete comment.answer;
  delete comment.failed;
  // Each question forks the recap afresh, so a follow-up only knows the thread it is told.
  const at = state.comments.indexOf(comment);
  const earlier = state.comments.filter(
    (c, i) =>
      i < at && c.kind === 'question' && c.answer && !c.failed &&
      c.section === comment.section && c.path === comment.path && c.row === comment.row,
  );
  const section = state.recap?.sections[comment.section];
  const file = tour.files.find((f) => f.path === comment.path);
  const row = comment.row !== undefined ? file?.rows[comment.row] : undefined;
  const where = row && comment.path ? `${comment.path}:${row.new ?? row.old}${row.kind === '-' ? ' (removed line)' : ''}` : undefined;
  const prompt = `The reviewer has a question while reading the section "${section?.title ?? '?'}".
${where ? `It is about ${where}:\n${row?.text}\n` : ''}${earlier.length ? `\nEarlier in this thread:\n${earlier.map((c) => `Q: ${c.body}\nA: ${c.answer}`).join('\n\n')}\n` : ''}
Question: ${comment.body}

Answer it by explaining the code, citing file:line. Stay neutral: explain, do not
judge, do not suggest changes. Be brief: a short paragraph, plain text.`;
  try {
    const result = await claude(tour.cwd, state.session ? ['--resume', state.session, '--fork-session'] : [], prompt, ASK_MS);
    comment.answer = result.result?.trim() || '(no answer)';
  } catch (error) {
    comment.answer = `Could not answer: ${(error as Error).message}`;
    comment.failed = true;
  }
  delete comment.asking;
  await save(tour.key);
}

/** Resolve a ref's lines from the snapshot, so it shows the code the review is about. */
async function refLines(tour: Open, state: TourState, path: string, start: number, end: number): Promise<string[]> {
  const out = await run('git', ['show', `${state.tree}:${path}`], { cwd: tour.cwd });
  if (out.code !== 0) return [];
  const lines = out.stdout.split('\n');
  return lines.slice(Math.max(0, start - 1), Math.min(lines.length, end));
}

/**
 * What the page draws from. Rebuilt from git each time; only the agent's cut is kept.
 * The files and the plain diff never wait for the recap: they are read while it builds.
 */
async function pageData(tour: Open, state: TourState): Promise<unknown> {
  const checked = state.status === 'ready' && state.recap ? checkRecap(state.recap, tour.files) : undefined;
  const files = Object.fromEntries(
    tour.files.map((f) => [f.path, { rows: f.rows, owners: checked?.owners[f.path] ?? [], status: f.status, oldPath: f.oldPath }]),
  );
  const base = {
    title: `${basename(tour.cwd)} vs ${against(tour)}`,
    repo: basename(tour.cwd),
    base: tour.base,
    against: against(tour),
    unstaged: tour.unstaged === true,
    startedAt: state.startedAt,
    now: Date.now(),
    status: state.status,
    error: state.error,
    checked: state.checked,
    comments: state.comments,
    files,
    plain: plainDiff(tour.files),
  };
  if (!checked) return base;
  const sections = await Promise.all(
    checked.sections.map(async (section) => ({
      ...section,
      refs: await Promise.all(
        section.refs.map(async (ref) => ({ ...ref, lines: await refLines(tour, state, ref.path, ref.start, ref.end) })),
      ),
    })),
  );
  return { ...base, sections };
}

/** A repo-relative path as an agent in `paneCwd` would write it. */
function pathFor(file: string, worktree: string, paneCwd: string | undefined): string {
  const absolute = `${worktree.replace(/\/$/, '')}/${file}`;
  if (!paneCwd) return absolute;
  const base = paneCwd.replace(/\/$/, '');
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length + 1) : absolute;
}

/**
 * The concerns as one prompt, in the shape the nvim review sent: where, the
 * line it was made on, what was said. Paths are written as the agent would
 * write them from its own directory, often the task folder above the worktree.
 */
export function concernPrompt(concerns: Concern[], worktree: string, paneCwd?: string): string {
  const out = ['Review comments on your changes. Address each one, and say so if you disagree with any.', ''];
  for (const c of concerns) {
    const path = pathFor(c.path, worktree, paneCwd);
    out.push(`## ${path}:${c.line}${c.side === 'old' ? ' (the code before your change)' : ''}`);
    if (c.code) out.push('```', c.code, '```');
    out.push(c.body.trim(), '');
    if (c.asked) out.push(`Before raising this, the reviewer asked: ${c.asked.question}`, `An agent reading the code answered: ${c.asked.answer}`, '');
  }
  return out.join('\n').trimEnd();
}

async function sendConcerns(tour: Open, state: TourState): Promise<SendOutcome> {
  const pending = state.comments.filter((c) => c.kind === 'concern' && !c.sent);
  if (pending.length === 0) return { ok: false, detail: 'no concerns to send' };
  const concerns = pending.map((c): Concern => {
    const file = tour.files.find((f) => f.path === c.path);
    const row = c.row !== undefined ? file?.rows[c.row] : undefined;
    const title = state.recap?.sections[c.section]?.title;
    return {
      path: c.path ?? `section "${title ?? c.section + 1}"`,
      line: row?.new ?? row?.old ?? 0,
      side: row?.kind === '-' ? 'old' : 'new',
      code: row?.text ?? '',
      body: c.body,
      ...(c.asked && c.answer ? { asked: { question: c.asked, answer: c.answer } } : {}),
    };
  });
  const outcome = await tour.send(concerns);
  if (outcome.ok) {
    for (const c of pending) c.sent = true;
    await save(tour.key);
  }
  return outcome;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function route(req: IncomingMessage, res: ServerResponse, palette: () => Promise<Palette>): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const [, t, key, action, id] = url.pathname.split('/');
  const tour = t === 't' && key ? tours.get(key) : undefined;
  const state = key ? await loadState(key) : undefined;
  if (!tour || !state) return json(res, { error: 'this review is no longer open — start it again from fleetwood' }, 404);

  if (req.method === 'GET' && !action) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(tourPage(await palette()));
    return;
  }
  if (req.method === 'GET' && action === 'data') return json(res, await pageData(tour, state));

  // Has the worktree moved past the snapshot this review is pinned to?
  if (req.method === 'GET' && action === 'stale') {
    const [from, tree] = await pin(tour);
    return json(res, { stale: from !== state.from || tree !== state.tree });
  }
  // The same worktree, the whole branch or only what is not staged.
  if (req.method === 'POST' && action === 'scope') {
    const { unstaged } = (await body(req)) as { unstaged?: boolean };
    try {
      const next = await prepare({ ...tour, unstaged: unstaged === true });
      return json(res, { key: next.key });
    } catch (error) {
      return json(res, { error: (error as Error).message }, 400);
    }
  }
  if (req.method === 'POST' && action === 'regenerate') {
    // Same snapshot: a rerun after an error. A new one: a fresh review.
    if (state.status === 'error') states.delete(key as string);
    const next = await prepare(tour);
    return json(res, { key: next.key });
  }
  if (req.method === 'POST' && action === 'check') {
    const { section, checked } = (await body(req)) as { section: number; checked: boolean };
    state.checked = state.checked.filter((s) => s !== section);
    if (checked) state.checked.push(section);
    await save(tour.key);
    return json(res, { checked: state.checked });
  }
  if (req.method === 'POST' && action === 'comments' && !id) {
    const input = (await body(req)) as Partial<TourComment>;
    if (!input.body?.trim() || (input.kind !== 'question' && input.kind !== 'concern')) {
      return json(res, { error: 'a comment needs a kind and a body' }, 400);
    }
    const comment: TourComment = {
      id: randomUUID(),
      section: Number(input.section),
      ...(input.path ? { path: input.path, row: Number(input.row) } : {}),
      kind: input.kind,
      body: input.body.trim(),
    };
    state.comments.push(comment);
    if (comment.kind === 'question') void ask(tour, state, comment);
    await save(tour.key);
    return json(res, comment);
  }
  if (action === 'comments' && id) {
    const comment = state.comments.find((c) => c.id === id);
    if (!comment) return json(res, { error: 'no such comment' }, 404);
    if (req.method === 'DELETE') state.comments = state.comments.filter((c) => c !== comment);
    else if (req.method === 'POST') {
      const input = (await body(req)) as { retry?: boolean; body?: string };
      if (input.retry && comment.kind === 'question') void ask(tour, state, comment);
      // A question the answer did not settle becomes something to fix, in the reviewer's words.
      else if (comment.kind === 'question' && !comment.asking) {
        comment.kind = 'concern';
        comment.asked = comment.body;
        comment.body = input.body?.trim() || comment.body;
      }
    }
    await save(tour.key);
    return json(res, { ok: true });
  }
  if (req.method === 'POST' && action === 'send') return json(res, await sendConcerns(tour, state));
  json(res, { error: 'not found' }, 404);
}

let server: Promise<string> | undefined;

/**
 * The one local server every review page is served from, started on first use
 * and living as long as the process. Reviews are told apart by their key in the
 * path, and are only reachable while this process knows them.
 */
function tourServer(palette: () => Promise<Palette>): Promise<string> {
  server ??= new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      route(req, res, palette).catch((error: Error) => {
        if (!res.headersSent) json(res, { error: error.message }, 500);
      });
    });
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });
  return server;
}

/**
 * Open a review of one worktree: pin it, start its recap, return the page.
 *
 * The page opens straight away and shows the recap building; a snapshot that
 * was already recapped opens on the recap, with its checkoffs and comments.
 */
export async function openTour(options: TourOptions & { palette: () => Promise<Palette> }): Promise<string> {
  const tour = await prepare(options);
  return `${await tourServer(options.palette)}/t/${tour.key}`;
}

export interface ReviewPane {
  paneId: string;
  cwd?: string;
  /** How the click names it back: `window: title`, as the nvim picker did. */
  label: string;
}

/**
 * The Claude pane a review of `worktree` should go to, if there is one.
 *
 * Only the task's own session, and only an agent at a terminal: a nested agent
 * is some other agent's helper, and pasting into its pane would type into the
 * parent. Among those, one working in this worktree beats one that is not — a
 * task with a reflow agent and a graphy agent wants each review back where it
 * came from — and otherwise the first is as good a guess as any.
 */
export function reviewPane(
  sessions: FleetSession[],
  session: string | undefined,
  worktree: string,
): ReviewPane | undefined {
  const home = sessions.find((s) => s.name === session);
  if (!home) return undefined;
  const claude = home.agents.filter((agent) => agent.tool === 'claude' && !agent.nested && agent.pane);
  const inside = (cwd: string | undefined): boolean =>
    cwd !== undefined && (cwd === worktree || cwd.startsWith(`${worktree}/`));
  const agent = claude.find((a) => inside(a.cwd)) ?? claude[0];
  if (!agent?.pane) return undefined;

  const pane = home.windows.flatMap((w) => w.panes.map((p) => ({ ...p, window: w.name }))).find(
    (p) => p.paneId === agent.pane,
  );
  return {
    paneId: agent.pane,
    cwd: agent.cwd ?? pane?.cwd,
    label: pane ? `${pane.window}: ${pane.title}` : agent.pane,
  };
}
