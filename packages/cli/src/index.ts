#!/usr/bin/env node
import {
  actions,
  buildFleet,
  github,
  hooks,
  prSession,
  proc,
  repoIndex,
  spool,
  tmux,
} from '@fleetwood/core';
import type { FleetState, PullRequest } from '@fleetwood/core';
import { c, pad, relativeAge, tildify, width } from './ui.ts';
import { renderAgentLine, renderFleet } from './render.ts';

const HELP = `${c.bold('fleetwood')} — tmux-native cockpit for coding agents

${c.bold('usage')}  fw [command] [options]

${c.bold('commands')}
  status            the fleet: sessions, agents, and what each is doing  ${c.dim('(default)')}
  watch             status, refreshed live
  agents            flat list of agents, most urgent first
  sessions          tmux sessions and their fleetwood metadata
  panes             every pane and the agent process found in it

  prs               pull requests awaiting your review, and your own
  open-pr <ref>     focus the session for a PR, or build one on a fresh worktree
  focus <session>   point the terminal at a session
  approve [pane]    answer yes to a blocked agent's permission prompt
  deny [pane]       answer no
  repos             local checkouts and the GitHub repos they map to

  install-hooks     register fleetwood's hooks with claude / cursor ${c.dim('(append-only, backs up first)')}
  doctor            check the environment fleetwood depends on
  help              this

${c.bold('options')}
  --json            machine-readable output
  --no-capture      skip reading pane contents ${c.dim('(faster, loses prompt detail)')}
  --interval <s>    watch refresh interval, default 2
  --background      create without stealing focus ${c.dim('(open-pr)')}

${c.bold('examples')}
  fw open-pr bigbluedisco/atlas#3671
  fw open-pr https://github.com/bigbluedisco/atlas/pull/3671
`;

function jsonOut(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function fleet(capture: boolean): Promise<FleetState> {
  return buildFleet({ capture });
}

async function cmdStatus(json: boolean, capture: boolean): Promise<void> {
  const state = await fleet(capture);
  if (json) return jsonOut(state);
  process.stdout.write(`${renderFleet(state)}\n`);
}

async function cmdWatch(capture: boolean, intervalSeconds: number): Promise<void> {
  const draw = async (): Promise<void> => {
    const state = await fleet(capture);
    // Clear and home, then paint. Cheaper and less flickery than full reset.
    process.stdout.write(`\x1b[H\x1b[2J${renderFleet(state)}\n`);
  };
  await draw();
  const timer = setInterval(() => void draw(), Math.max(500, intervalSeconds * 1000));
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\n');
    process.exit(0);
  });
}

async function cmdAgents(json: boolean, capture: boolean): Promise<void> {
  const state = await fleet(capture);
  const agents = [...state.sessions.flatMap((s) => s.agents), ...state.orphans];
  if (json) return jsonOut(agents);
  if (agents.length === 0) {
    process.stdout.write(`${c.muted('no agents running in tmux')}\n`);
    return;
  }
  const bySession = new Map<string, string>();
  for (const s of state.sessions) for (const a of s.agents) bySession.set(a.key, s.name);
  const nameWidth = Math.max(...[...bySession.values()].map((n) => width(n)), 8);
  for (const agent of agents) {
    const session = pad(bySession.get(agent.key) ?? c.dim('—'), nameWidth);
    process.stdout.write(`${c.bold(session)}${renderAgentLine(agent, ' ')}\n`);
  }
}

async function cmdSessions(json: boolean): Promise<void> {
  const sessions = await tmux.snapshot();
  if (json) return jsonOut(sessions);
  if (sessions.length === 0) {
    process.stdout.write(`${c.muted('no tmux server running')}\n`);
    return;
  }
  const nameWidth = Math.max(...sessions.map((s) => width(s.name)), 10);
  for (const s of sessions) {
    const dot = s.attached > 0 ? c.foam('●') : c.muted('○');
    const panes = s.windows.reduce((n, w) => n + w.panes.length, 0);
    const meta = [
      s.meta.kind && c.iris(s.meta.kind),
      s.meta.repo && c.rose(s.meta.repo),
      s.meta.branch && c.gold(s.meta.branch),
      s.meta.pr && c.love(s.meta.pr),
    ]
      .filter(Boolean)
      .join(c.muted(' · '));
    process.stdout.write(
      `${dot} ${c.bold(pad(s.name, nameWidth))} ${c.muted(pad(`${s.windows.length}w ${panes}p`, 8))} ${c.dim(pad(tildify(s.path), 34))} ${meta || c.dim('no fleetwood metadata')} ${c.muted(relativeAge(s.createdAt))}\n`,
    );
  }
}

async function cmdPanes(json: boolean): Promise<void> {
  const [sessions, table] = await Promise.all([tmux.snapshot(), proc.scanProcesses()]);
  const rows = sessions.flatMap((s) =>
    s.windows.flatMap((w) =>
      w.panes.map((p) => ({
        session: s.name,
        window: `${w.index}:${w.name}`,
        pane: p.paneId,
        pid: p.pid,
        command: p.command,
        cwd: p.cwd,
        title: p.title,
        agents: proc.agentsInPane(table, p.pid),
      })),
    ),
  );
  if (json) return jsonOut(rows);
  if (rows.length === 0) {
    process.stdout.write(`${c.muted('no panes')}\n`);
    return;
  }
  const w1 = Math.max(...rows.map((r) => width(r.session)), 7);
  for (const r of rows) {
    const agents =
      r.agents.length > 0
        ? r.agents.map((a) => `${c.iris(a.tool)} ${c.muted(`pid ${a.pid}`)}`).join(' ')
        : c.muted(r.command);
    process.stdout.write(
      `${pad(r.session, w1)} ${c.muted(pad(r.pane, 4))} ${pad(agents, 28)} ${c.dim(tildify(r.cwd))}\n`,
    );
  }
}

async function cmdInstallHooks(json: boolean): Promise<void> {
  const report = await hooks.installAll();
  if (json) return jsonOut(report);

  process.stdout.write(`${c.bold('hook scripts')} ${c.muted(report.hooksDir)}\n`);
  for (const s of report.scripts) process.stdout.write(`  ${c.foam('✓')} ${c.dim(s)}\n`);

  const section = (
    title: string,
    r: { path: string; added: string[]; alreadyPresent: string[]; backup?: string; skipped?: string; error?: string },
  ): void => {
    process.stdout.write(`\n${c.bold(title)} ${c.muted(r.path)}\n`);
    if (r.error) {
      process.stdout.write(`  ${c.love('✗')} ${r.error}\n`);
      return;
    }
    if (r.skipped) {
      process.stdout.write(`  ${c.muted(`skipped — ${r.skipped}`)}\n`);
      return;
    }
    if (r.backup) process.stdout.write(`  ${c.dim(`backup → ${r.backup}`)}\n`);
    if (r.added.length > 0) {
      process.stdout.write(`  ${c.foam('✓')} added ${r.added.length}: ${c.dim(r.added.join(', '))}\n`);
    }
    if (r.alreadyPresent.length > 0) {
      process.stdout.write(`  ${c.muted(`already present: ${r.alreadyPresent.length}`)}\n`);
    }
  };

  section('claude', report.claude);
  section('cursor', report.cursor);

  process.stdout.write(`\n${c.bold('codex')} ${c.muted(report.codex.path)}\n`);
  if (report.codex.skipped) {
    process.stdout.write(`  ${c.muted(`skipped — ${report.codex.skipped}`)}\n`);
  } else if (report.codex.instructions) {
    process.stdout.write(`  ${c.muted('TOML is not edited automatically. Add this line yourself:')}\n`);
    process.stdout.write(`    ${c.gold(report.codex.instructions)}\n`);
  } else {
    process.stdout.write(`  ${c.foam('✓')} already configured\n`);
  }

  process.stdout.write(
    `\n${c.muted('Existing hooks were left untouched. New agent sessions pick this up; already-running ones keep their old config.')}\n`,
  );
}

interface Check {
  name: string;
  ok: boolean | 'warn';
  detail: string;
}

async function cmdDoctor(json: boolean): Promise<void> {
  const checks: Check[] = [];

  const tmuxVersion = await tmux.version();
  checks.push({
    name: 'tmux',
    ok: (Number.parseFloat(tmuxVersion) || 0) >= 3.0,
    detail: tmuxVersion ? `${tmuxVersion} (need >= 3.0)` : 'not found',
  });

  const state = await buildFleet({ capture: false });
  checks.push({
    name: 'tmux server',
    ok: true,
    detail:
      state.sessions.length > 0
        ? `${state.sessions.length} sessions, ${state.counts.total} agents`
        : 'not running (nothing to show, not an error)',
  });

  const status = await hooks.hookStatus();
  checks.push({
    name: 'claude hooks',
    ok: status.claude.installed === status.claude.total ? true : status.claude.installed > 0 ? 'warn' : false,
    detail: `${status.claude.installed}/${status.claude.total} events registered${
      status.claude.installed === 0 ? ' — run `fw install-hooks`' : ''
    }`,
  });
  checks.push({
    name: 'cursor hooks',
    ok: !status.cursor.available
      ? 'warn'
      : status.cursor.installed === status.cursor.total
        ? true
        : status.cursor.installed > 0
          ? 'warn'
          : false,
    detail: !status.cursor.available
      ? 'cursor-agent not configured here'
      : `${status.cursor.installed}/${status.cursor.total} events registered`,
  });

  // Agents visible to ps but silent on hooks mean the wiring isn't live yet.
  const unhooked = state.sessions
    .flatMap((s) => s.agents)
    .filter((a) => a.provenance === 'process');
  checks.push({
    name: 'agent coverage',
    ok: unhooked.length === 0 ? true : 'warn',
    detail:
      unhooked.length === 0
        ? 'every running agent is reporting via hooks'
        : `${unhooked.length} running agent(s) never sent a hook (started before install?): ${unhooked
            .map((a) => `${a.tool}@${a.pane}`)
            .join(', ')}`,
  });

  // Sessions `claude daemon` hosts are bound to a pane by inference, not by
  // report, so say out loud when one couldn't be placed — that is the difference
  // between "agent missing" and "agent listed without a terminal".
  const daemonBound = state.sessions
    .flatMap((s) => s.agents)
    .filter((a) => a.hosted === 'daemon');
  const daemonLoose = state.orphans.filter((a) => a.orphanReason === 'daemon-hosted');
  checks.push({
    name: 'claude daemon',
    ok: daemonLoose.length === 0 ? true : 'warn',
    detail:
      daemonBound.length + daemonLoose.length === 0
        ? 'no daemon-hosted sessions'
        : `${daemonBound.length} matched to a pane${
            daemonLoose.length > 0
              ? `, ${daemonLoose.length} without one (listed under "no terminal matched")`
              : ''
          }`,
  });

  const pending = await spool.readSpool();
  checks.push({
    name: 'spool',
    ok: pending.bad.length === 0,
    detail: `${pending.files.length} pending event(s)${pending.bad.length > 0 ? `, ${pending.bad.length} unparseable` : ''}`,
  });

  const gh = await import('node:child_process');
  const ghOk = await new Promise<string>((res) => {
    gh.execFile('gh', ['auth', 'status'], (err, _out, errOut) => {
      res(err ? `not usable: ${(errOut || '').split('\n')[0] ?? 'unknown'}` : 'authenticated');
    });
  });
  checks.push({ name: 'gh cli', ok: ghOk === 'authenticated', detail: ghOk });

  if (json) return jsonOut(checks);

  for (const check of checks) {
    const mark = check.ok === true ? c.foam('✓') : check.ok === 'warn' ? c.gold('!') : c.love('✗');
    process.stdout.write(`${mark} ${pad(check.name, 16)} ${c.muted(check.detail)}\n`);
  }
  if (checks.some((k) => k.ok === false)) process.exitCode = 1;
}

function checksMark(pr: PullRequest): string {
  switch (pr.checks) {
    case 'passing':
      return c.foam('✓');
    case 'failing':
      return c.love('✗');
    case 'pending':
      return c.gold('◍');
    default:
      return c.dim('·');
  }
}

function reviewMark(pr: PullRequest): string {
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return c.foam('approved');
    case 'CHANGES_REQUESTED':
      return c.love('changes');
    case 'REVIEW_REQUIRED':
      return c.gold('needs review');
    default:
      return c.dim('—');
  }
}

async function cmdPrs(json: boolean): Promise<void> {
  const [lists, sessions] = await Promise.all([github.fetchPrs(), tmux.listSessions()]);
  if (json) return jsonOut(lists);

  if (lists.degraded) {
    process.stdout.write(`${c.love('gh returned nothing')} ${c.muted('— check `gh auth status`')}\n`);
    return;
  }

  const linked = new Set(sessions.map((s) => s.meta.pr).filter(Boolean) as string[]);

  const section = (title: string, prs: PullRequest[]): void => {
    process.stdout.write(`\n${c.bold(title)} ${c.muted(`(${prs.length})`)}\n`);
    if (prs.length === 0) {
      process.stdout.write(`  ${c.dim('nothing')}\n`);
      return;
    }
    for (const pr of prs) {
      const key = `${pr.repo}#${pr.number}`;
      const session = linked.has(key) ? c.foam(' ⇄ session') : '';
      const draft = pr.isDraft ? c.dim(' draft') : '';
      process.stdout.write(
        `  ${checksMark(pr)} ${c.bold(pad(`#${pr.number}`, 7))} ${c.muted(pad(pr.repo, 24))} ${pad(pr.title.slice(0, 46), 46)} ${pad(reviewMark(pr), 14)}${draft}${session}\n`,
      );
    }
  };

  section('needs my review', lists.reviewRequested);
  section('mine', lists.mine);
  process.stdout.write(`\n${c.dim('open one with: fw open-pr <repo>#<number>')}\n`);
}

/** Accepts `owner/repo#123`, a full PR URL, or `#123` inside a stamped session. */
function parsePrRef(ref: string): { repo: string; number: number } | undefined {
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref);
  if (url?.[1] && url[2]) return { repo: url[1], number: Number.parseInt(url[2], 10) };
  const short = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  if (short?.[1] && short[2]) return { repo: short[1], number: Number.parseInt(short[2], 10) };
  return undefined;
}

async function cmdOpenPr(ref: string | undefined, background: boolean): Promise<void> {
  if (!ref) {
    process.stderr.write(`${c.love('usage')} fw open-pr <owner/repo#number | pr-url>\n`);
    process.exitCode = 2;
    return;
  }
  const parsed = parsePrRef(ref);
  if (!parsed) {
    process.stderr.write(`${c.love('could not parse')} ${ref}\n`);
    process.exitCode = 2;
    return;
  }

  // Look the PR up so we get its head branch; without it we'd guess the ref.
  const lists = await github.fetchPrs();
  const found = [...lists.reviewRequested, ...lists.mine].find(
    (p) => p.repo === parsed.repo && p.number === parsed.number,
  );
  const pr: PullRequest =
    found ??
    ({
      repo: parsed.repo,
      number: parsed.number,
      title: `#${parsed.number}`,
      url: `https://github.com/${parsed.repo}/pull/${parsed.number}`,
      updatedAt: '',
      isDraft: false,
      roles: [],
    } satisfies PullRequest);

  const result = await prSession.openPr(pr, { background });
  process.stdout.write(`${result.ok ? c.foam('✓') : c.love('✗')} ${result.detail}\n`);
  if (!result.ok) process.exitCode = 1;
}

async function cmdFocus(name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write(`${c.love('usage')} fw focus <session>\n`);
    process.exitCode = 2;
    return;
  }
  const result = await actions.focusSession(name);
  process.stdout.write(`${result.ok ? c.foam('✓') : c.love('✗')} ${result.detail}\n`);
  if (!result.ok) process.exitCode = 1;
}

/** Answer whichever blocked agent is in `pane`, or the only blocked one. */
async function cmdAnswer(target: string | undefined, kind: 'approve' | 'deny'): Promise<void> {
  const state = await buildFleet({ capture: true });
  const blocked = state.sessions
    .flatMap((s) => s.agents)
    .filter((a) => a.status === 'blocked_permission' && a.prompt);

  const agent = target ? blocked.find((a) => a.pane === target) : blocked[0];
  if (!agent?.prompt) {
    process.stderr.write(
      `${c.love('no blocked agent')} ${c.muted(target ? `in ${target}` : 'with a readable prompt')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!target && blocked.length > 1) {
    process.stderr.write(`${c.love('ambiguous')} ${blocked.length} agents are blocked — name a pane\n`);
    process.exitCode = 2;
    return;
  }

  const key = kind === 'approve' ? agent.prompt.approve : agent.prompt.deny;
  if (!key) {
    process.stderr.write(`${c.love('no obvious')} ${kind} option in: ${agent.prompt.question ?? '?'}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${c.muted(agent.prompt.question ?? '')}\n`);
  const result = await actions.answerPrompt(agent.pane as string, key);
  process.stdout.write(`${result.ok ? c.foam('✓') : c.love('✗')} ${result.detail}\n`);
}

async function cmdRepos(json: boolean): Promise<void> {
  const index = await repoIndex.buildIndex();
  if (json) return jsonOut(index);
  const withRemote = index.repos.filter((r) => r.nameWithOwner);
  const plain = index.repos.filter((r) => !r.isRepo);
  process.stdout.write(
    `${c.bold(`${index.repos.length} projects`)} ${c.muted(
      `· ${withRemote.length} with a GitHub origin · ${plain.length} not git repos`,
    )}\n`,
  );
  for (const repo of withRemote) {
    process.stdout.write(`  ${pad(c.iris(repo.nameWithOwner as string), 34)} ${c.dim(tildify(repo.path))}\n`);
  }
  for (const repo of plain) {
    process.stdout.write(`  ${pad(c.muted('—'), 34)} ${c.dim(tildify(repo.path))}\n`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const capture = !argv.includes('--no-capture');
  const intervalIndex = argv.indexOf('--interval');
  const interval =
    intervalIndex >= 0 ? Number.parseFloat(argv[intervalIndex + 1] ?? '2') || 2 : 2;
  const positional = argv.filter((a) => !a.startsWith('-'));
  const command = positional[0] ?? 'status';
  const arg = positional[1];
  const background = argv.includes('--background');

  switch (command) {
    case 'status':
      await cmdStatus(json, capture);
      break;
    case 'watch':
      await cmdWatch(capture, interval);
      break;
    case 'agents':
      await cmdAgents(json, capture);
      break;
    case 'sessions':
    case 'ls':
      await cmdSessions(json);
      break;
    case 'panes':
      await cmdPanes(json);
      break;
    case 'prs':
      await cmdPrs(json);
      break;
    case 'open-pr':
      await cmdOpenPr(arg, background);
      break;
    case 'focus':
      await cmdFocus(arg);
      break;
    case 'approve':
      await cmdAnswer(arg, 'approve');
      break;
    case 'deny':
      await cmdAnswer(arg, 'deny');
      break;
    case 'repos':
      await cmdRepos(json);
      break;
    case 'install-hooks':
      await cmdInstallHooks(json);
      break;
    case 'doctor':
      await cmdDoctor(json);
      break;
    case 'help':
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`${c.love('unknown command')} ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

await main();
