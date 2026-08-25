import { formatCost, formatMoney } from '@fleetwood/core';
import type {
  AgentStatus,
  AgentUsage,
  FleetAgent,
  FleetState,
  PlanLimits,
} from '@fleetwood/core';
import { c, pad, relativeAge, tildify, width } from './ui.ts';

/**
 * The Claude plan's quota, as `/usage` shows it.
 *
 * Rendered as bars rather than bare percentages because the point is a glance:
 * how much runway is left before the fleet stalls, not the exact figure.
 *
 * Labelled `claude` in that tool's own colour: a fleet also running cursor-agent
 * or codex would otherwise read this as covering all of them, when those have
 * separate quotas fleetwood has no way to see.
 */
export function renderLimits(limits: PlanLimits): string {
  if (limits.windows.length === 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const titleWidth = Math.max(...limits.windows.map((w) => width(w.title)));
  const lines: string[] = [`  ${c.accent('claude')} ${c.muted('plan usage')}`];

  for (const window of limits.windows) {
    const percent = Math.round(window.utilization * 100);
    const filled = Math.max(1, Math.round(window.utilization * 16));
    const paint = percent >= 90 ? c.danger : percent >= 75 ? c.warn : c.ok;
    const bar = `${paint('█'.repeat(filled))}${c.dim('░'.repeat(16 - filled))}`;
    const reset =
      window.resetsAt === undefined
        ? ''
        : window.resetsAt - now <= 0
          ? c.dim(' resetting')
          : c.dim(` resets ${duration(window.resetsAt - now)}`);
    lines.push(
      `  ${c.muted(pad(window.title, titleWidth))}  ${bar} ${pad(`${percent}%`, 4)}${reset}`,
    );
  }
  if (limits.stale) {
    lines.push(c.dim(`  as of ${duration(now - limits.fetchedAt)} ago`));
  }
  return lines.join('\n');
}

interface Style {
  glyph: string;
  paint: (s: string) => string;
  label: string;
}

const STYLES: Record<AgentStatus, Style> = {
  working: { glyph: '▶', paint: c.ok, label: 'working' },
  blocked_permission: { glyph: '✋', paint: c.danger, label: 'permission' },
  blocked_input: { glyph: '✋', paint: c.warn, label: 'waiting' },
  compacting: { glyph: '⟳', paint: c.accent, label: 'compacting' },
  idle: { glyph: '○', paint: c.muted, label: 'idle' },
  starting: { glyph: '◌', paint: c.muted, label: 'starting' },
  error: { glyph: '✗', paint: c.danger, label: 'error' },
  gone: { glyph: '×', paint: c.dim, label: 'gone' },
};

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  // Roll over to days: a session left running for a week is not "167h".
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
  }
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

function toolLabel(tool: string): string {
  switch (tool) {
    case 'claude':
      return c.accent('claude');
    case 'cursor':
      return c.ok('cursor');
    case 'codex':
      return c.warn('codex ');
    default:
      return c.muted(tool);
  }
}

/** A trust marker, so an inferred status never looks as solid as a reported one. */
function provenanceMark(agent: FleetAgent): string {
  switch (agent.provenance) {
    case 'hook':
      return '';
    case 'screen':
      return c.dim('~');
    case 'process':
      return c.dim('?');
    case 'stale':
      return c.dim('…');
  }
}

/**
 * Spend, or blank space where we have none.
 *
 * Cost rather than tokens: cache reads are the bulk of any token count, so the
 * token figure is enormous for every busy agent and says nothing about which one
 * is expensive. `~` marks a floor — some model had no published rate on file.
 * The column is padded either way so the durations after it stay aligned.
 */
function costColumn(usage: AgentUsage | undefined): string {
  if (!usage || usage.costUsd <= 0) return pad('', 8);
  return c.muted(pad(formatCost(usage), 8));
}

export function renderAgentLine(agent: FleetAgent, indent = '    '): string {
  const style = STYLES[agent.status];
  const status = `${style.paint(style.glyph)} ${pad(style.paint(style.label), 11)}`;
  // "up 6h" reads as uptime; a bare "6h" would claim the agent has been in this
  // status that long, which nothing measured.
  const age = agent.ageIsUptime ? `up ${duration(agent.forSeconds)}` : duration(agent.forSeconds);
  const forTime = c.muted(pad(age, 8));
  // ⤶ a nested agent, ⇢ one hosted by the claude daemon and matched to this pane.
  const nested = agent.nested ? c.dim('⤶') : agent.hosted ? c.dim('⇢') : ' ';
  const subagents = agent.subagents > 0 ? c.accent(` +${agent.subagents}`) : '';
  const activity = agent.activity ? c.dim(` ${agent.activity}`) : '';
  const pane = c.muted(pad(agent.pane ?? '—', 4));
  return `${indent}${status}${provenanceMark(agent)} ${pane} ${toolLabel(agent.tool)}${nested}${subagents} ${forTime}${costColumn(agent.usage)}${activity}`;
}

export function renderFleet(fleet: FleetState, limits?: PlanLimits): string {
  const lines: string[] = [];
  const { counts } = fleet;

  const summary = [
    counts.working > 0 ? c.ok(`${counts.working} working`) : '',
    counts.blocked_permission + counts.blocked_input > 0
      ? c.danger(`${counts.blocked_permission + counts.blocked_input} blocked`)
      : '',
    counts.idle > 0 ? c.muted(`${counts.idle} idle`) : '',
    // Summed over sessions and orphans alike, so the header agrees with the rows.
    counts.costUsd > 0 ? c.warn(formatMoney(counts.costUsd)) : '',
  ].filter(Boolean);

  lines.push(
    `${c.bold('fleetwood')} ${c.muted('·')} ${fleet.sessions.length} sessions ${c.muted('·')} ${
      summary.length > 0 ? summary.join(c.muted(' · ')) : c.muted('no agents')
    }`,
  );
  lines.push('');

  if (fleet.sessions.length === 0) {
    lines.push(c.muted('  no tmux server running'));
    return lines.join('\n');
  }

  const nameWidth = Math.max(...fleet.sessions.map((s) => width(s.name)), 10);

  for (const session of fleet.sessions) {
    const attached = session.attached > 0 ? c.ok('●') : c.muted('○');
    const attention = session.needsAttention ? c.danger(' ✋') : '';
    const kind = session.meta.kind ? c.accent(session.meta.kind) : '';
    const pr = session.meta.pr ? c.warn(` ${session.meta.pr}`) : '';
    const branch = session.meta.branch ? c.branch(` ${session.meta.branch}`) : '';

    const spend = session.usage?.costUsd ? ` ${c.muted(formatCost(session.usage))}` : '';

    lines.push(
      `${attached} ${c.bold(pad(session.name, nameWidth))}${attention} ${kind}${branch}${pr} ${c.muted(tildify(session.path))} ${c.dim(relativeAge(session.createdAt))}${spend}`,
    );

    if (session.agents.length === 0) {
      const panes = session.windows.reduce((n, w) => n + w.panes.length, 0);
      lines.push(`    ${c.dim(`no agents · ${panes} pane${panes === 1 ? '' : 's'}`)}`);
    } else {
      // Whoever needs the human comes first.
      const ordered = [...session.agents].sort((a, b) => rank(a) - rank(b));
      for (const agent of ordered) lines.push(renderAgentLine(agent));
    }
    lines.push('');
  }

  // Two different situations, so don't file them under one scary label: a
  // daemon-hosted one is running fine — we just couldn't tell which terminal is
  // showing it. Editor-hosted agents are dropped in buildFleet, not listed here.
  const ORPHAN_LABELS = {
    'pane-gone': 'pane gone (ended without a closing event):',
    'daemon-hosted': 'hosted by the claude daemon (no terminal matched):',
  } as const;
  for (const [reason, label] of Object.entries(ORPHAN_LABELS)) {
    const group = fleet.orphans.filter((a) => (a.orphanReason ?? 'pane-gone') === reason);
    if (group.length === 0) continue;
    lines.push(c.muted(label));
    for (const agent of group) lines.push(renderAgentLine(agent));
    lines.push('');
  }

  const body = lines.join('\n').replace(/\n+$/, '\n');

  // Quota last: it is standing context for one agent tool, not a per-agent fact,
  // so it reads as a footer rather than competing with the fleet for the top.
  const bars = limits ? renderLimits(limits) : '';
  return bars ? `${body}\n${bars}\n` : body;
}

function rank(agent: FleetAgent): number {
  switch (agent.status) {
    case 'blocked_permission':
      return 0;
    case 'blocked_input':
      return 1;
    case 'error':
      return 2;
    case 'working':
      return 3;
    case 'compacting':
      return 4;
    case 'starting':
      return 5;
    case 'idle':
      return 6;
    case 'gone':
      return 7;
  }
}
