#!/usr/bin/env node
/**
 * Spawn an isolated worktree + tmux session + claude agent for one task.
 *
 * Standalone on purpose: zero dependencies, shells out to git and tmux, so it
 * runs from any repo without a build step or a node_modules. It does not import
 * @fleetwood/core — but it deliberately mirrors core's conventions, so the
 * cockpit recognises what it creates:
 *
 *   - worktrees land in `worktreeDir` from ~/.fleetwood/config.json
 *     (default `.agents/worktrees`), same as core/worktree.ts
 *   - `.agents/` goes into .git/info/exclude, not the tracked .gitignore
 *   - the session is stamped with the same @fw_* user options core reads
 *   - the session name matches core's sessionNameFor(path), so fleetwood's
 *     find-or-create lands in this session instead of making a second one
 *
 * Find-or-create throughout: running it twice for the same task focuses what
 * exists rather than spawning a duplicate.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 8 << 20, ...opts });
    return { ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? err),
    };
  }
}

const git = (repo, args, opts) => run('git', ['-C', repo, ...args], opts);
const tmux = (args) => run('tmux', args);

function die(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ naming */

/**
 * Filesystem- and tmux-safe. tmux forbids `.` and `:` in session names, and the
 * session name is derived from this slug, so they are stripped here rather than
 * sanitised twice later.
 */
function slugify(input) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replaceAll('.', '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug;
}

/* ------------------------------------------------------------------ config */

/** Mirrors core/config.ts: a partial config file must not lose the defaults. */
async function worktreeDir() {
  const fwHome = process.env.FLEETWOOD_HOME ?? join(homedir(), '.fleetwood');
  try {
    const raw = JSON.parse(await readFile(join(fwHome, 'config.json'), 'utf8'));
    if (typeof raw.worktreeDir === 'string' && raw.worktreeDir.length > 0) return raw.worktreeDir;
  } catch {
    // No config yet, or unreadable — the default is the documented behaviour.
  }
  return '.agents/worktrees';
}

/* -------------------------------------------------------------------- repo */

/**
 * Resolve the MAIN worktree, even when invoked from inside a linked one.
 *
 * `--show-toplevel` would return the linked worktree, and nesting a worktree
 * inside a worktree makes a mess that `git worktree remove` then refuses to
 * clean up. `--git-common-dir` always points at the main repo's .git.
 */
async function mainRepoRoot(cwd) {
  const inside = await run('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) die(`not a git repository: ${cwd}`);

  const common = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) die(`could not resolve the repo root: ${common.stderr.trim()}`);
  const gitDir = common.stdout.trim();
  // A bare-ish or unusual layout: fall back to the toplevel rather than guess.
  if (!gitDir.endsWith('/.git')) {
    const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    return top.ok ? top.stdout.trim() : dirname(gitDir);
  }
  return dirname(gitDir);
}

/** `owner/repo` from origin, when there is an origin. Stamped as @fw_repo. */
async function githubSlug(repo) {
  const { ok, stdout } = await git(repo, ['remote', 'get-url', 'origin']);
  if (!ok) return undefined;
  const url = stdout.trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1];
}

/**
 * Pick the base commit for the new branch.
 *
 * Explicit --base wins. Otherwise prefer the remote default branch (so a fresh
 * task never inherits half-finished local state) but fall back to HEAD, because
 * a repo with no remote at all is a perfectly normal local project.
 */
async function resolveBase(repo, explicit, quiet) {
  if (explicit) {
    const { ok } = await git(repo, ['rev-parse', '--verify', '--quiet', explicit]);
    if (!ok) die(`--base ${explicit} is not a ref in this repo`);
    return { ref: explicit, note: `explicit base ${explicit}` };
  }

  const remotes = await git(repo, ['remote']);
  const hasOrigin = remotes.ok && remotes.stdout.split('\n').some((r) => r.trim() === 'origin');
  if (!hasOrigin) {
    return { ref: 'HEAD', note: 'no origin remote — branched from local HEAD' };
  }

  if (!quiet) process.stderr.write('  fetching origin…\n');
  await git(repo, ['fetch', '--quiet', 'origin'], { timeout: 120_000 });

  // origin/HEAD is only set if someone ran `set-head`; derive it when missing.
  let head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!head.ok) {
    await git(repo, ['remote', 'set-head', 'origin', '--auto'], { timeout: 60_000 });
    head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  }
  if (head.ok) {
    const ref = head.stdout.trim();
    return { ref, note: `branched from ${ref}` };
  }

  for (const candidate of ['origin/main', 'origin/master']) {
    const { ok } = await git(repo, ['rev-parse', '--verify', '--quiet', candidate]);
    if (ok) return { ref: candidate, note: `branched from ${candidate}` };
  }
  return { ref: 'HEAD', note: 'could not resolve origin default branch — branched from local HEAD' };
}

/**
 * Keep worktrees out of `git status` without touching the tracked .gitignore.
 * Ported from core/worktree.ts: .git/info/exclude is local-only, so this never
 * shows up in a diff or a PR.
 */
async function ensureExcluded(repo, entry = '.agents/') {
  const excludeFile = join(repo, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludeFile, 'utf8');
  } catch {
    try {
      await mkdir(join(repo, '.git', 'info'), { recursive: true });
    } catch {
      return;
    }
  }
  if (current.split('\n').some((l) => l.trim() === entry.trim())) return;
  const next = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current;
  try {
    await writeFile(excludeFile, `${next}${entry}\n`, 'utf8');
  } catch {
    // Non-fatal: worst case the worktree shows up as untracked.
  }
}

/** Parse `git worktree list --porcelain`, which is record-per-blank-line. */
function parseWorktrees(stdout) {
  const out = [];
  let current = {};
  const flush = () => {
    if (current.path) out.push({ path: current.path, branch: current.branch, locked: current.locked ?? false });
    current = {};
  };
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') current.path = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') current.locked = true;
  }
  flush();
  return out;
}

async function listWorktrees(repo) {
  const { ok, stdout } = await git(repo, ['worktree', 'list', '--porcelain']);
  return ok ? parseWorktrees(stdout) : [];
}

/* -------------------------------------------------------------------- tmux */

async function sessionExists(name) {
  const { ok } = await tmux(['has-session', '-t', `=${name}`]);
  return ok;
}

/**
 * Where a session is rooted.
 *
 * BARE session name, like set-option and for a worse reason: with the `=`
 * exact-match prefix, `display-message` exits 0 and prints an EMPTY string
 * instead of failing. A guard built on that silently passes. Verified against
 * tmux 3.6a.
 */
async function sessionPath(name) {
  const { ok, stdout } = await tmux(['display-message', '-p', '-t', name, '#{session_path}']);
  const path = stdout.trim();
  return ok && path.length > 0 ? path : undefined;
}

async function firstPane(name) {
  const { ok, stdout } = await tmux(['list-panes', '-t', `=${name}`, '-F', '#{pane_id}']);
  if (!ok) return undefined;
  return stdout.trim().split('\n')[0] || undefined;
}

const META_OPTIONS = {
  kind: '@fw_kind',
  repo: '@fw_repo',
  branch: '@fw_branch',
  pr: '@fw_pr',
  worktree: '@fw_worktree',
};

/**
 * Stamp fleetwood metadata onto the session.
 *
 * Note the BARE session name: unlike has-session and list-panes, `set-option -t`
 * rejects the `=` exact-match prefix with "no such session: =name". This is
 * called out in core/tmux.ts too — verified again here against tmux 3.6a.
 */
async function stamp(name, meta) {
  for (const [key, option] of Object.entries(META_OPTIONS)) {
    const value = meta[key];
    if (value === undefined) continue;
    await tmux(['set-option', '-t', name, option, value]);
  }
}

/** POSIX single-quote quoting, for a command typed into an interactive shell. */
function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

/** Send literal text then Enter separately, so tmux never reads it as keys. */
async function sendLine(pane, text) {
  const typed = await tmux(['send-keys', '-t', pane, '-l', text]);
  if (!typed.ok) return false;
  const { ok } = await tmux(['send-keys', '-t', pane, 'Enter']);
  return ok;
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const opts = { agent: true, focus: false, json: false, setup: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--prompt':
      case '-p':
        opts.prompt = argv[++i];
        break;
      case '--base':
        opts.base = argv[++i];
        break;
      case '--branch':
        opts.branch = argv[++i];
        break;
      case '--session':
        opts.session = argv[++i];
        break;
      case '--repo':
        opts.repo = argv[++i];
        break;
      case '--setup':
        opts.setup = argv[++i];
        break;
      case '--no-agent':
        opts.agent = false;
        break;
      case '--focus':
        opts.focus = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) die(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  opts.task = positional.join(' ');
  return opts;
}

const HELP = `spawn a worktree + tmux session + claude agent for one task

usage  node .claude/skills/spawn-worktree/spawn.mjs <task> [options]

  <task>              name of the task; slugified into the branch, directory
                      and session name

options
  -p, --prompt <text>  initial prompt, passed to claude as its argv prompt
  --base <ref>         branch base (default: origin default branch, else HEAD)
  --branch <name>      branch name (default: the slug)
  --session <name>     tmux session name (default: the slug)
  --repo <path>        repo to spawn from (default: the cwd's main worktree)
  --setup <cmd>        shell command to run in the worktree before claude
                       starts, e.g. --setup 'pnpm install'
  --no-agent           create the worktree and session, leave the pane at a shell
  --focus              switch to the new session (default: leave focus alone)
  --json               machine-readable result

examples
  node .claude/skills/spawn-worktree/spawn.mjs fix-stale-hooks
  node .claude/skills/spawn-worktree/spawn.mjs 'stale hook states' \\
    -p 'a SIGKILLed agent never reports Stop; make dead-process beat hook state'
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!opts.task) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  const slug = slugify(opts.task);
  if (!slug) die(`"${opts.task}" slugifies to nothing usable — pass a task name with letters or digits`);

  const repo = opts.repo ?? (await mainRepoRoot(process.cwd()));
  const branch = opts.branch ?? slug;
  const session = opts.session ?? slug;
  const target = join(repo, await worktreeDir(), slug);
  const log = (line) => {
    if (!opts.json) process.stdout.write(`${line}\n`);
  };

  if (!(await run('tmux', ['-V'])).ok) die('tmux is not installed or not on PATH');

  /* --- find-or-create the worktree ------------------------------------- */

  const existing = await listWorktrees(repo);
  const onBranch = existing.find((w) => w.branch === branch);
  const atTarget = existing.find((w) => w.path === target);

  let worktreePath;
  let created = false;
  let baseNote = '';

  if (onBranch) {
    worktreePath = onBranch.path;
    log(`• reusing worktree on ${branch} at ${worktreePath}`);
  } else if (atTarget) {
    worktreePath = atTarget.path;
    log(`• reusing worktree at ${worktreePath} (on ${atTarget.branch ?? 'a detached HEAD'})`);
  } else {
    const branchTaken = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
    if (branchTaken) {
      die(
        `branch ${branch} already exists but has no worktree — ` +
          `check it out somewhere, or pass --branch <other-name>`,
      );
    }

    const base = await resolveBase(repo, opts.base, opts.json);
    baseNote = base.note;

    await ensureExcluded(repo);
    await mkdir(dirname(target), { recursive: true });

    const add = await git(repo, ['worktree', 'add', '-b', branch, target, base.ref], { timeout: 120_000 });
    if (!add.ok) die(`git worktree add failed: ${add.stderr.trim()}`);
    worktreePath = target;
    created = true;
    log(`✓ worktree ${worktreePath}`);
    log(`  ${base.note}`);
  }

  /* --- find-or-create the session -------------------------------------- */

  let sessionCreated = false;
  if (await sessionExists(session)) {
    // A name collision would drop this task into someone else's checkout and
    // stamp their session with our metadata, so refuse rather than reuse the
    // wrong one. Fails CLOSED: an unverifiable path is a refusal, not a pass.
    const where = await sessionPath(session);
    if (!where) {
      die(`tmux session "${session}" exists but its path could not be read — refusing to reuse it blindly`);
    }
    if (where !== worktreePath) {
      die(
        `tmux session "${session}" already exists but sits in ${where}, not ${worktreePath} — ` +
          `pass --session <other-name>`,
      );
    }
    log(`• reusing tmux session ${session}`);
  } else {
    const newSession = await tmux(['new-session', '-ds', session, '-c', worktreePath, '-n', 'claude']);
    if (!newSession.ok) die(`tmux refused to create ${session}: ${newSession.stderr.trim()}`);
    sessionCreated = true;
    log(`✓ tmux session ${session}`);
  }

  await stamp(session, {
    kind: 'worktree',
    repo: await githubSlug(repo),
    branch,
    worktree: worktreePath,
  });

  /* --- setup + agent ---------------------------------------------------- */

  const pane = await firstPane(session);
  if (!pane) die(`created ${session} but it has no pane`);

  if (opts.setup && sessionCreated) {
    await sendLine(pane, opts.setup);
    log(`  running setup: ${opts.setup}`);
  }

  let agentStarted = false;
  if (opts.agent && sessionCreated) {
    // Typed into the shell rather than exec'd as the pane command, so the pane
    // survives claude exiting and keeps its scrollback. The prompt goes in as
    // claude's argv, which avoids racing the agent's boot to type into its UI.
    const command = opts.prompt ? `claude ${shellQuote(opts.prompt)}` : 'claude';
    if (!(await sendLine(pane, command))) die(`could not type into ${pane}`);
    agentStarted = true;
    log(`✓ claude starting in ${pane}${opts.prompt ? ' with your prompt' : ''}`);
  } else if (opts.agent && !sessionCreated) {
    log(`• session already existed — not starting a second claude`);
  }

  /* --- focus ------------------------------------------------------------ */

  let focused = false;
  if (opts.focus) {
    if (process.env.TMUX) {
      focused = (await tmux(['switch-client', '-t', session])).ok;
    } else {
      focused = (await tmux(['attach-session', '-t', session])).ok;
    }
    if (!focused) log(`  could not switch automatically — attach with: tmux attach -t ${session}`);
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: true, session, branch, worktree: worktreePath, pane, created, sessionCreated, agentStarted, focused, baseNote },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!opts.focus) {
    log('');
    log(`  attach:  tmux attach -t ${session}`);
    log(`  watch:   pnpm fw status`);
  }
}

await main();
